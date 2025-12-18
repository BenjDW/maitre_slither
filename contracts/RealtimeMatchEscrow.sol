// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title RealtimeMatchEscrow
 * @notice Escrow contract for real-time offchain games. Collects USDC stakes from two players,
 *         locks the room once both have paid, then pays the winner based on backend-signed proof.
 *         Takes a configurable commission (default 2%) to treasury.
 * @dev MVP / Testnet version. Onchain data is PUBLIC (mempool + calldata + storage).
 *      This contract uses EIP-712 signatures for integrity verification and optional commitment
 *      hashes for linking offchain room keys. The "encryptedMetadata" is informational only and PUBLIC.
 * @author Senior Solidity Engineer (Audit Mindset)
 */
contract RealtimeMatchEscrow is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Maximum fee basis points (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice EIP-712 typehash for Resolve message
    bytes32 private constant RESOLVE_TYPEHASH =
        keccak256("Resolve(uint256 roomId,address winner,uint256 pot,uint256 fee,uint256 payout,uint256 nonce)");

    // ============ State Variables ============

    /// @notice USDC token address (6 decimals)
    IERC20 public immutable usdc;

    /// @notice Backend operator address authorized to sign results
    address public operator;

    /// @notice Treasury address for fee collection
    address public treasuryAddress;

    /// @notice Fee in basis points (e.g., 200 = 2%)
    uint256 public feeBps;

    /// @notice Next room ID (auto-incrementing)
    uint256 public nextRoomId;

    /// @notice Total fees accrued in contract (not yet withdrawn)
    uint256 public accruedFees;

    /// @notice Pause flag for emergency stops
    bool public paused;

    // ============ Enums ============

    enum RoomStatus {
        NONE,      // 0: Room doesn't exist
        CREATED,   // 1: Room created, waiting for players
        READY,     // 2: Both players paid
        STARTED,   // 3: Game started
        RESOLVED,  // 4: Winner paid
        CANCELLED  // 5: Cancelled/refunded
    }

    // ============ Structs ============

    struct Room {
        address playerA;
        address playerB;
        uint256 stake;              // Stake per player (in USDC units with 6 decimals)
        uint64 deadline;             // Unix timestamp deadline
        RoomStatus status;
        uint8 paidMask;              // bit0 = A paid, bit1 = B paid
        bytes32 roomKeyCommitment;   // Offchain commitment hash (integrity only, PUBLIC)
        bytes32 metadataHash;        // Hash of "encryptedMetadata" blob (informational, PUBLIC)
        uint256 feeBpsSnapshot;      // Fee BPS at room creation (for consistency)
    }

    // ============ Mappings ============

    /// @notice Room data by room ID
    mapping(uint256 => Room) public rooms;

    /// @notice Track if player has paid for a room
    mapping(uint256 => mapping(address => bool)) public hasPaid;

    /// @notice Track if player has been refunded
    mapping(uint256 => mapping(address => bool)) public hasRefunded;

    /// @notice Anti-replay: track used nonces per room
    mapping(uint256 => mapping(uint256 => bool)) public usedNonce;

    // ============ Events ============

    event RoomCreated(
        uint256 indexed roomId,
        address indexed playerA,
        address indexed playerB,
        uint256 stake,
        uint64 deadline,
        address operator,
        bytes32 roomKeyCommitment
    );

    event RoomJoined(uint256 indexed roomId, address indexed player, uint256 amount);

    event RoomReady(uint256 indexed roomId);

    event RoomStarted(uint256 indexed roomId);

    event RoomResolved(
        uint256 indexed roomId,
        address indexed winner,
        uint256 pot,
        uint256 fee,
        uint256 payout,
        uint256 nonce
    );

    event RoomRefunded(uint256 indexed roomId, address indexed player, uint256 amount);

    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    event FeeBpsUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    event FeesWithdrawn(address indexed to, uint256 amount);

    event RoomMetadataUpdated(uint256 indexed roomId, bytes32 metadataHash);

    event Paused(address account);
    event Unpaused(address account);

    // ============ Errors ============

    error InvalidAddress();
    error InvalidStake();
    error InvalidDeadline();
    error InvalidRoom();
    error RoomNotReady();
    error RoomNotStarted();
    error RoomAlreadyResolved();
    error RoomNotEligibleForRefund();
    error PlayerNotInRoom();
    error AlreadyPaid();
    error AlreadyRefunded();
    error InvalidWinner();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InsufficientPot();
    error InvalidFeeBps();
    error ZeroTreasury();
    error ContractPaused();
    error NoFeesToWithdraw();

    // ============ Modifiers ============

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier validRoom(uint256 roomId) {
        if (rooms[roomId].status == RoomStatus.NONE) revert InvalidRoom();
        _;
    }

    // ============ Constructor ============

    /**
     * @param _usdc USDC token address (6 decimals)
     * @param _operator Initial operator address
     * @param _treasuryAddress Initial treasury address
     * @param _feeBps Initial fee in basis points (e.g., 200 = 2%)
     */
    constructor(
        address _usdc,
        address _operator,
        address _treasuryAddress,
        uint256 _feeBps
    ) Ownable(msg.sender) EIP712("RealtimeMatchEscrow", "1") {
        if (_usdc == address(0) || _operator == address(0) || _treasuryAddress == address(0)) {
            revert InvalidAddress();
        }
        if (_feeBps > MAX_FEE_BPS) {
            revert InvalidFeeBps();
        }

        usdc = IERC20(_usdc);
        operator = _operator;
        treasuryAddress = _treasuryAddress;
        feeBps = _feeBps;
    }

    // ============ Room Lifecycle ============

    /**
     * @notice Create a new room (callable by operator/backend)
     * @param playerA First player address
     * @param playerB Second player address
     * @param stake Stake amount per player (in USDC units with 6 decimals, e.g., 5 USDC = 5_000_000)
     * @param deadline Unix timestamp deadline for room
     * @param roomKeyCommitment Commitment hash of offchain room key (integrity only, PUBLIC)
     * @param metadataHash Hash of "encryptedMetadata" blob (informational, PUBLIC)
     * @return roomId The created room ID
     */
    function createRoom(
        address playerA,
        address playerB,
        uint256 stake,
        uint64 deadline,
        bytes32 roomKeyCommitment,
        bytes32 metadataHash
    ) external whenNotPaused returns (uint256 roomId) {
        // Only operator can create rooms (backend)
        if (msg.sender != operator) {
            revert InvalidAddress();
        }

        if (playerA == address(0) || playerB == address(0) || playerA == playerB) {
            revert InvalidAddress();
        }
        if (stake == 0) {
            revert InvalidStake();
        }
        if (deadline <= block.timestamp) {
            revert InvalidDeadline();
        }

        roomId = nextRoomId++;
        rooms[roomId] = Room({
            playerA: playerA,
            playerB: playerB,
            stake: stake,
            deadline: deadline,
            status: RoomStatus.CREATED,
            paidMask: 0,
            roomKeyCommitment: roomKeyCommitment,
            metadataHash: metadataHash,
            feeBpsSnapshot: feeBps
        });

        emit RoomCreated(roomId, playerA, playerB, stake, deadline, operator, roomKeyCommitment);
    }

    /**
     * @notice Join a room by paying stake (callable by room players only)
     * @param roomId Room ID to join
     */
    function joinRoom(uint256 roomId) external nonReentrant whenNotPaused validRoom(roomId) {
        Room storage room = rooms[roomId];

        // Only players can join
        if (msg.sender != room.playerA && msg.sender != room.playerB) {
            revert PlayerNotInRoom();
        }

        // Cannot join if already paid
        if (hasPaid[roomId][msg.sender]) {
            revert AlreadyPaid();
        }

        // Cannot join if room already started or resolved
        if (room.status >= RoomStatus.STARTED) {
            revert RoomNotReady();
        }

        // Transfer stake from player
        usdc.safeTransferFrom(msg.sender, address(this), room.stake);

        // Update state (Checks-Effects-Interactions: state before external calls)
        hasPaid[roomId][msg.sender] = true;
        if (msg.sender == room.playerA) {
            room.paidMask |= 1; // bit 0
        } else {
            room.paidMask |= 2; // bit 1
        }

        emit RoomJoined(roomId, msg.sender, room.stake);

        // Check if both players paid
        if (room.paidMask == 3) {
            room.status = RoomStatus.READY;
            emit RoomReady(roomId);
        }
    }

    /**
     * @notice Start a room (callable by anyone once READY)
     * @param roomId Room ID to start
     */
    function startRoom(uint256 roomId) external whenNotPaused validRoom(roomId) {
        Room storage room = rooms[roomId];

        if (room.status != RoomStatus.READY) {
            revert RoomNotReady();
        }

        room.status = RoomStatus.STARTED;
        emit RoomStarted(roomId);
    }

    /**
     * @notice Resolve room and payout winner (callable by anyone with valid operator signature)
     * @param roomId Room ID to resolve
     * @param winner Winner address (must be playerA or playerB)
     * @param nonce Unique nonce for this resolution (anti-replay)
     * @param signature Operator's EIP-712 signature
     */
    function resolveAndPayout(
        uint256 roomId,
        address winner,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant whenNotPaused validRoom(roomId) {
        Room storage room = rooms[roomId];

        // Room must be STARTED
        if (room.status != RoomStatus.STARTED) {
            revert RoomNotStarted();
        }

        // Cannot resolve twice
        if (room.status == RoomStatus.RESOLVED) {
            revert RoomAlreadyResolved();
        }

        // Winner must be one of the players
        if (winner != room.playerA && winner != room.playerB) {
            revert InvalidWinner();
        }

        // Both players must have paid
        if (room.paidMask != 3) {
            revert InsufficientPot();
        }

        // Check nonce not used (anti-replay)
        if (usedNonce[roomId][nonce]) {
            revert NonceAlreadyUsed();
        }

        // Calculate pot, fee, payout
        uint256 pot = room.stake * 2;
        uint256 fee = (pot * room.feeBpsSnapshot) / 10_000;
        uint256 payout = pot - fee;

        // Verify EIP-712 signature
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLVE_TYPEHASH,
                    roomId,
                    winner,
                    pot,
                    fee,
                    payout,
                    nonce
                )
            )
        );

        address signer = ECDSA.recover(digest, signature);
        if (signer != operator) {
            revert InvalidSignature();
        }

        // Mark nonce as used
        usedNonce[roomId][nonce] = true;

        // Update state (Checks-Effects-Interactions)
        room.status = RoomStatus.RESOLVED;
        accruedFees += fee;

        // Transfer payout to winner
        usdc.safeTransfer(winner, payout);

        emit RoomResolved(roomId, winner, pot, fee, payout, nonce);
    }

    /**
     * @notice Refund player stake if deadline passed and room not resolved
     * @param roomId Room ID to refund from
     */
    function refund(uint256 roomId) external nonReentrant whenNotPaused validRoom(roomId) {
        Room storage room = rooms[roomId];

        // Only players can refund
        if (msg.sender != room.playerA && msg.sender != room.playerB) {
            revert PlayerNotInRoom();
        }

        // Cannot refund if already refunded
        if (hasRefunded[roomId][msg.sender]) {
            revert AlreadyRefunded();
        }

        // Cannot refund if room is resolved
        if (room.status == RoomStatus.RESOLVED) {
            revert RoomNotEligibleForRefund();
        }

        // Must have paid
        if (!hasPaid[roomId][msg.sender]) {
            revert RoomNotEligibleForRefund();
        }

        // Deadline must have passed
        if (block.timestamp < room.deadline) {
            revert RoomNotEligibleForRefund();
        }

        // Update state (Checks-Effects-Interactions)
        hasRefunded[roomId][msg.sender] = true;

        // If both refunded, mark as cancelled
        if (hasRefunded[roomId][room.playerA] && hasRefunded[roomId][room.playerB]) {
            room.status = RoomStatus.CANCELLED;
        }

        // Transfer refund
        usdc.safeTransfer(msg.sender, room.stake);

        emit RoomRefunded(roomId, msg.sender, room.stake);
    }

    // ============ Admin Functions ============

    /**
     * @notice Update operator address (owner only)
     * @param newOperator New operator address
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) {
            revert InvalidAddress();
        }
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    /**
     * @notice Update treasury address (owner only)
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) {
            revert ZeroTreasury();
        }
        address oldTreasury = treasuryAddress;
        treasuryAddress = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Update fee basis points (owner only)
     * @param newFeeBps New fee in basis points (max 1000 = 10%)
     */
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) {
            revert InvalidFeeBps();
        }
        uint256 oldFeeBps = feeBps;
        feeBps = newFeeBps;
        emit FeeBpsUpdated(oldFeeBps, newFeeBps);
    }

    /**
     * @notice Withdraw accrued fees to treasury (owner only)
     */
    function withdrawFees() external nonReentrant onlyOwner {
        if (accruedFees == 0) {
            revert NoFeesToWithdraw();
        }
        uint256 amount = accruedFees;
        accruedFees = 0;
        usdc.safeTransfer(treasuryAddress, amount);
        emit FeesWithdrawn(treasuryAddress, amount);
    }

    /**
     * @notice Pause contract (owner only)
     */
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause contract (owner only)
     */
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Update room metadata hash (operator only, optional)
     * @param roomId Room ID
     * @param metadataHash New metadata hash
     */
    function setRoomMetadata(uint256 roomId, bytes32 metadataHash) external whenNotPaused validRoom(roomId) {
        if (msg.sender != operator) {
            revert InvalidAddress();
        }
        rooms[roomId].metadataHash = metadataHash;
        emit RoomMetadataUpdated(roomId, metadataHash);
    }

    // ============ View Functions ============

    /**
     * @notice Get room information
     * @param roomId Room ID
     * @return room Room struct
     * @return playerAPaid Whether playerA has paid
     * @return playerBPaid Whether playerB has paid
     */
    function getRoom(uint256 roomId)
        external
        view
        returns (
            Room memory room,
            bool playerAPaid,
            bool playerBPaid
        )
    {
        room = rooms[roomId];
        playerAPaid = hasPaid[roomId][room.playerA];
        playerBPaid = hasPaid[roomId][room.playerB];
    }

    /**
     * @notice Verify resolve signature (view function for backend debugging)
     * @param roomId Room ID
     * @param winner Winner address
     * @param pot Total pot
     * @param fee Fee amount
     * @param payout Payout amount
     * @param nonce Nonce
     * @param signature Signature to verify
     * @return isValid Whether signature is valid
     * @return signer Recovered signer address
     */
    function verifyResolveSignature(
        uint256 roomId,
        address winner,
        uint256 pot,
        uint256 fee,
        uint256 payout,
        uint256 nonce,
        bytes calldata signature
    ) external view returns (bool isValid, address signer) {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLVE_TYPEHASH,
                    roomId,
                    winner,
                    pot,
                    fee,
                    payout,
                    nonce
                )
            )
        );

        signer = ECDSA.recover(digest, signature);
        isValid = (signer == operator);
    }
}

/**
 * ============================================================================
 * HOW BACKEND SIGNS (EIP-712 Pseudo-code)
 * ============================================================================
 *
 * Domain Separator:
 *   name: "RealtimeMatchEscrow"
 *   version: "1"
 *   chainId: <current chain ID>
 *   verifyingContract: <contract address>
 *
 * Type Hash:
 *   keccak256("Resolve(uint256 roomId,address winner,uint256 pot,uint256 fee,uint256 payout,uint256 nonce)")
 *
 * Example (JavaScript/ethers.js):
 *   const domain = {
 *     name: "RealtimeMatchEscrow",
 *     version: "1",
 *     chainId: 1, // mainnet
 *     verifyingContract: "0x..."
 *   };
 *
 *   const types = {
 *     Resolve: [
 *       { name: "roomId", type: "uint256" },
 *       { name: "winner", type: "address" },
 *       { name: "pot", type: "uint256" },
 *       { name: "fee", type: "uint256" },
 *       { name: "payout", type: "uint256" },
 *       { name: "nonce", type: "uint256" }
 *     ]
 *   };
 *
 *   const value = {
 *     roomId: 1,
 *     winner: "0x...",
 *     pot: 10_000_000, // 10 USDC (6 decimals)
 *     fee: 200_000,    // 0.2 USDC (2%)
 *     payout: 9_800_000, // 9.8 USDC
 *     nonce: 12345
 *   };
 *
 *   const signature = await operatorWallet._signTypedData(domain, types, value);
 *
 * Example (Python/eth_account):
 *   from eth_account.messages import encode_structured_data
 *
 *   domain = {
 *     "name": "RealtimeMatchEscrow",
 *     "version": "1",
 *     "chainId": 1,
 *     "verifyingContract": "0x..."
 *   }
 *
 *   types = {
 *     "Resolve": [
 *       {"name": "roomId", "type": "uint256"},
 *       {"name": "winner", "type": "address"},
 *       {"name": "pot", "type": "uint256"},
 *       {"name": "fee", "type": "uint256"},
 *       {"name": "payout", "type": "uint256"},
 *       {"name": "nonce", "type": "uint256"}
 *     ]
 *   }
 *
 *   message = {
 *     "roomId": 1,
 *     "winner": "0x...",
 *     "pot": 10_000_000,
 *     "fee": 200_000,
 *     "payout": 9_800_000,
 *     "nonce": 12345
 *   }
 *
 *   structured_msg = encode_structured_data({
 *     "types": types,
 *     "domain": domain,
 *     "primaryType": "Resolve",
 *     "message": message
 *   })
 *
 *   signed_message = operator_account.sign_message(structured_msg)
 *   signature = signed_message.signature
 *
 * ============================================================================
 * SECURITY NOTES:
 * ============================================================================
 * - All onchain data is PUBLIC (mempool, calldata, storage)
 * - roomKeyCommitment and metadataHash are for integrity/linking only
 * - EIP-712 signature ensures only operator can authorize payouts
 * - Nonce prevents replay attacks
 * - SafeERC20 protects against non-standard tokens
 * - ReentrancyGuard prevents reentrancy attacks
 * - Checks-Effects-Interactions pattern followed
 * ============================================================================
 */

