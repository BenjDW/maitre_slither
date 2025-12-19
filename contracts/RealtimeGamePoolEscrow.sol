// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RealtimeGamePoolEscrow
 * @notice Escrow contract for game pools. Collects USDC buy-ins from multiple players,
 *         starts a game once enough players joined, reserves fees, and allows backend
 *         to settle players (death exit: 50%, alive exit: 100%). Players can revive
 *         by paying again. All value transfers are in USDC (ERC20).
 * @dev Backend is authoritative for game state and player "in-game value", but the contract
 *      MUST enforce strict state + anti-replay + sane bounds to prevent accidental drain.
 *      Backend will be the transaction sender (relayer) for settlements and will pay gas offchain.
 * @author Senior Solidity Engineer (Audit Mindset)
 */
contract RealtimeGamePoolEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Maximum fee basis points (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    // ============ Enums ============

    enum GameStatus {
        NONE,      // 0: Game doesn't exist
        WAITING,   // 1: Game created, waiting for players
        FULL,      // 2: Target players reached (optional, can go directly to LIVE)
        LIVE,      // 3: Game started
        ENDED,     // 4: Game ended
        CANCELLED  // 5: Game cancelled
    }

    // ============ Structs ============

    struct Game {
        uint32 targetPlayers;
        uint64 joinDeadline;
        uint256 buyIn;
        uint256 potAtStart;      // Total deposits at game start
        uint256 reservedFee;     // Fee reserved at start (accounting)
        uint256 totalDeposited;  // Sum of all buyIns (including revives)
        uint256 totalPaidOut;    // Sum of payouts done
        GameStatus status;
    }

    // ============ State Variables ============

    /// @notice USDC token address (6 decimals)
    IERC20 public immutable usdc;

    /// @notice Backend operator address authorized to manage games
    address public operator;

    /// @notice Treasury address for fee collection
    address public treasury;

    /// @notice Fee in basis points (e.g., 200 = 2%)
    uint256 public feeBps;

    /// @notice Next game ID (auto-incrementing)
    uint256 public nextGameId;

    /// @notice Total fees accrued in contract (not yet withdrawn)
    uint256 public accruedFees;

    // ============ Mappings ============

    /// @notice Game data by game ID
    mapping(uint256 => Game) public games;

    /// @notice Total deposits per player per game (sum of buyIns including revives)
    mapping(uint256 => mapping(address => uint256)) public playerDeposited;

    /// @notice Whether player is currently active in game
    mapping(uint256 => mapping(address => bool)) public playerActive;

    /// @notice Whether player ever joined the game
    mapping(uint256 => mapping(address => bool)) public playerEverJoined;

    /// @notice Whether player has exited (died or alive)
    mapping(uint256 => mapping(address => bool)) public playerExited;

    /// @notice Anti-replay: track used event IDs per game
    mapping(uint256 => mapping(uint256 => bool)) public usedEventId;

    /// @notice Count of active players in game
    mapping(uint256 => uint256) public activePlayerCount;

    // ============ Events ============

    event GameCreated(
        uint256 indexed gameId,
        uint256 buyIn,
        uint32 targetPlayers,
        uint64 joinDeadline
    );

    event PlayerJoined(
        uint256 indexed gameId,
        address indexed player,
        uint256 amount,
        uint256 totalPlayerDeposited
    );

    event GameFull(uint256 indexed gameId);

    event GameStarted(
        uint256 indexed gameId,
        uint256 potAtStart,
        uint256 reservedFee,
        uint256 feeBps
    );

    event PlayerDeathSettled(
        uint256 indexed gameId,
        address indexed player,
        uint256 value,
        uint256 payout,
        uint256 indexed eventId
    );

    event PlayerAliveSettled(
        uint256 indexed gameId,
        address indexed player,
        uint256 value,
        uint256 payout,
        uint256 indexed eventId
    );

    event PlayerRevived(
        uint256 indexed gameId,
        address indexed player,
        uint256 amount,
        uint256 totalPlayerDeposited
    );

    event GameEnded(
        uint256 indexed gameId,
        uint256 reservedFee,
        address indexed treasury
    );

    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    event FeeBpsUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    event FeesWithdrawn(address indexed to, uint256 amount);

    // ============ Errors ============

    error InvalidAddress();
    error InvalidGame();
    error InvalidBuyIn();
    error InvalidTargetPlayers();
    error InvalidDeadline();
    error InvalidFeeBps();
    error InvalidValue();
    error GameNotWaiting();
    error GameNotLive();
    error GameAlreadyStarted();
    error GameAlreadyEnded();
    error DeadlinePassed();
    error PlayerNotActive();
    error PlayerAlreadyActive();
    error PlayerNotExited();
    error PlayerAlreadyExited();
    error EventIdAlreadyUsed();
    error InsufficientFunds();
    error NotOperator();
    error ZeroTreasury();

    // ============ Modifiers ============

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier validGame(uint256 gameId) {
        if (games[gameId].status == GameStatus.NONE) revert InvalidGame();
        _;
    }

    // ============ Constructor ============

    /**
     * @param usdc_ USDC token address (6 decimals)
     * @param operator_ Initial operator address
     * @param treasury_ Initial treasury address
     * @param feeBps_ Initial fee in basis points (e.g., 200 = 2%)
     */
    constructor(
        address usdc_,
        address operator_,
        address treasury_,
        uint256 feeBps_
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || operator_ == address(0) || treasury_ == address(0)) {
            revert InvalidAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) {
            revert InvalidFeeBps();
        }

        usdc = IERC20(usdc_);
        operator = operator_;
        treasury = treasury_;
        feeBps = feeBps_;
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
        address oldTreasury = treasury;
        treasury = newTreasury;
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
     * @param amount Amount to withdraw (0 = withdraw all)
     */
    function withdrawFees(uint256 amount) external nonReentrant onlyOwner {
        uint256 toWithdraw = amount == 0 ? accruedFees : amount;
        if (toWithdraw == 0 || toWithdraw > accruedFees) {
            revert InsufficientFunds();
        }
        accruedFees -= toWithdraw;
        usdc.safeTransfer(treasury, toWithdraw);
        emit FeesWithdrawn(treasury, toWithdraw);
    }

    // ============ Game Lifecycle Functions ============

    /**
     * @notice Create a new game pool (operator only)
     * @param buyIn Buy-in amount per player (in USDC units with 6 decimals)
     * @param targetPlayers Target number of players to start game
     * @param joinDeadline Unix timestamp deadline for joining
     * @return gameId The created game ID
     */
    function createGame(
        uint256 buyIn,
        uint32 targetPlayers,
        uint64 joinDeadline
    ) external onlyOperator returns (uint256 gameId) {
        if (buyIn == 0) {
            revert InvalidBuyIn();
        }
        if (targetPlayers == 0) {
            revert InvalidTargetPlayers();
        }
        if (joinDeadline <= block.timestamp) {
            revert InvalidDeadline();
        }

        gameId = nextGameId++;
        games[gameId] = Game({
            targetPlayers: targetPlayers,
            joinDeadline: joinDeadline,
            buyIn: buyIn,
            potAtStart: 0,
            reservedFee: 0,
            totalDeposited: 0,
            totalPaidOut: 0,
            status: GameStatus.WAITING
        });

        emit GameCreated(gameId, buyIn, targetPlayers, joinDeadline);
    }

    /**
     * @notice Join a game by paying buy-in (anyone can call, including backend relayer)
     * @param gameId Game ID to join
     */
    function joinGame(uint256 gameId) external nonReentrant validGame(gameId) {
        Game storage game = games[gameId];

        // Cannot join if game already started or ended
        if (game.status >= GameStatus.LIVE) {
            revert GameNotWaiting();
        }

        // Cannot join after deadline
        if (block.timestamp > game.joinDeadline) {
            revert DeadlinePassed();
        }

        // Transfer buy-in from player
        usdc.safeTransferFrom(msg.sender, address(this), game.buyIn);

        // Update state (Checks-Effects-Interactions)
        if (!playerEverJoined[gameId][msg.sender]) {
            playerEverJoined[gameId][msg.sender] = true;
            playerActive[gameId][msg.sender] = true;
            activePlayerCount[gameId]++;
        } else {
            // Player rejoining (should use revive if they exited)
            if (!playerActive[gameId][msg.sender]) {
                playerActive[gameId][msg.sender] = true;
                activePlayerCount[gameId]++;
            }
        }

        playerDeposited[gameId][msg.sender] += game.buyIn;
        game.totalDeposited += game.buyIn;

        emit PlayerJoined(gameId, msg.sender, game.buyIn, playerDeposited[gameId][msg.sender]);

        // Check if target players reached (optional: can still start manually)
        if (activePlayerCount[gameId] >= game.targetPlayers && game.status == GameStatus.WAITING) {
            game.status = GameStatus.FULL;
            emit GameFull(gameId);
        }
    }

    /**
     * @notice Start a game (operator only)
     * @param gameId Game ID to start
     */
    function startGame(uint256 gameId) external onlyOperator validGame(gameId) {
        Game storage game = games[gameId];

        // Game must be WAITING or FULL
        if (game.status != GameStatus.WAITING && game.status != GameStatus.FULL) {
            revert GameNotWaiting();
        }

        // Update state (Checks-Effects-Interactions)
        game.status = GameStatus.LIVE;
        game.potAtStart = game.totalDeposited;
        game.reservedFee = (game.potAtStart * feeBps) / 10_000;

        emit GameStarted(gameId, game.potAtStart, game.reservedFee, feeBps);
    }

    /**
     * @notice Settle a player's death exit (operator only)
     * @param gameId Game ID
     * @param player Player address to settle
     * @param value Player's in-game value (backend authoritative)
     * @param eventId Unique event ID for anti-replay
     */
    function settleDeathExit(
        uint256 gameId,
        address player,
        uint256 value,
        uint256 eventId
    ) external onlyOperator nonReentrant validGame(gameId) {
        Game storage game = games[gameId];

        // Game must be LIVE
        if (game.status != GameStatus.LIVE) {
            revert GameNotLive();
        }

        // Player must be active
        if (!playerActive[gameId][player]) {
            revert PlayerNotActive();
        }

        // Player must not already be exited
        if (playerExited[gameId][player]) {
            revert PlayerAlreadyExited();
        }

        // Check event ID not used (anti-replay)
        if (usedEventId[gameId][eventId]) {
            revert EventIdAlreadyUsed();
        }

        // Value must be greater than 0
        if (value == 0) {
            revert InvalidValue();
        }

        // Calculate payout (50% of value)
        uint256 payout = value / 2;

        // Check available funds (reservedFee is accounting only, not yet transferred)
        uint256 available = game.totalDeposited - game.reservedFee - game.totalPaidOut;
        if (payout > available) {
            revert InsufficientFunds();
        }

        // Update state (Checks-Effects-Interactions)
        usedEventId[gameId][eventId] = true;
        playerActive[gameId][player] = false;
        playerExited[gameId][player] = true;
        activePlayerCount[gameId]--;
        game.totalPaidOut += payout;

        // Transfer payout to player
        usdc.safeTransfer(player, payout);

        emit PlayerDeathSettled(gameId, player, value, payout, eventId);
    }

    /**
     * @notice Settle a player's alive exit (operator only)
     * @param gameId Game ID
     * @param player Player address to settle
     * @param value Player's in-game value (backend authoritative)
     * @param eventId Unique event ID for anti-replay
     */
    function settleAliveExit(
        uint256 gameId,
        address player,
        uint256 value,
        uint256 eventId
    ) external onlyOperator nonReentrant validGame(gameId) {
        Game storage game = games[gameId];

        // Game must be LIVE
        if (game.status != GameStatus.LIVE) {
            revert GameNotLive();
        }

        // Player must be active
        if (!playerActive[gameId][player]) {
            revert PlayerNotActive();
        }

        // Player must not already be exited
        if (playerExited[gameId][player]) {
            revert PlayerAlreadyExited();
        }

        // Check event ID not used (anti-replay)
        if (usedEventId[gameId][eventId]) {
            revert EventIdAlreadyUsed();
        }

        // Value must be greater than 0
        if (value == 0) {
            revert InvalidValue();
        }

        // Calculate payout (100% of value)
        uint256 payout = value;

        // Check available funds (reservedFee is accounting only, not yet transferred)
        uint256 available = game.totalDeposited - game.reservedFee - game.totalPaidOut;
        if (payout > available) {
            revert InsufficientFunds();
        }

        // Update state (Checks-Effects-Interactions)
        usedEventId[gameId][eventId] = true;
        playerActive[gameId][player] = false;
        playerExited[gameId][player] = true;
        activePlayerCount[gameId]--;
        game.totalPaidOut += payout;

        // Transfer payout to player
        usdc.safeTransfer(player, payout);

        emit PlayerAliveSettled(gameId, player, value, payout, eventId);
    }

    /**
     * @notice Revive a player by paying buy-in again (anyone can call, including backend relayer)
     * @param gameId Game ID
     */
    function revive(uint256 gameId) external nonReentrant validGame(gameId) {
        Game storage game = games[gameId];

        // Game must be LIVE
        if (game.status != GameStatus.LIVE) {
            revert GameNotLive();
        }

        // Player must have previously joined
        if (!playerEverJoined[gameId][msg.sender]) {
            revert PlayerNotActive();
        }

        // Player must have exited (died)
        if (!playerExited[gameId][msg.sender]) {
            revert PlayerNotExited();
        }

        // Player must not be currently active
        if (playerActive[gameId][msg.sender]) {
            revert PlayerAlreadyActive();
        }

        // Transfer buy-in from player
        usdc.safeTransferFrom(msg.sender, address(this), game.buyIn);

        // Update state (Checks-Effects-Interactions)
        playerActive[gameId][msg.sender] = true;
        playerExited[gameId][msg.sender] = false;
        activePlayerCount[gameId]++;
        playerDeposited[gameId][msg.sender] += game.buyIn;
        game.totalDeposited += game.buyIn;

        emit PlayerRevived(gameId, msg.sender, game.buyIn, playerDeposited[gameId][msg.sender]);
        emit PlayerJoined(gameId, msg.sender, game.buyIn, playerDeposited[gameId][msg.sender]);
    }

    /**
     * @notice End a game and transfer fees to treasury (operator only)
     * @param gameId Game ID to end
     */
    function endGame(uint256 gameId) external onlyOperator nonReentrant validGame(gameId) {
        Game storage game = games[gameId];

        // Game must be LIVE
        if (game.status != GameStatus.LIVE) {
            revert GameNotLive();
        }

        // Update state (Checks-Effects-Interactions)
        game.status = GameStatus.ENDED;

        // Transfer reserved fee to treasury (or accrue)
        if (game.reservedFee > 0) {
            accruedFees += game.reservedFee;
            // Optionally transfer immediately:
            // usdc.safeTransfer(treasury, game.reservedFee);
        }

        emit GameEnded(gameId, game.reservedFee, treasury);
    }

    // ============ View Functions ============

    /**
     * @notice Get game information
     * @param gameId Game ID
     * @return game Game struct
     */
    function getGame(uint256 gameId) external view returns (Game memory game) {
        game = games[gameId];
    }

    /**
     * @notice Get player state for a game
     * @param gameId Game ID
     * @param player Player address
     * @return deposited Total deposits (including revives)
     * @return active Whether player is currently active
     * @return everJoined Whether player ever joined
     * @return exited Whether player has exited
     */
    function getPlayerState(
        uint256 gameId,
        address player
    )
        external
        view
        returns (
            uint256 deposited,
            bool active,
            bool everJoined,
            bool exited
        )
    {
        deposited = playerDeposited[gameId][player];
        active = playerActive[gameId][player];
        everJoined = playerEverJoined[gameId][player];
        exited = playerExited[gameId][player];
    }

    /**
     * @notice Get available balance for payouts in a game (replaces old maxValue concept)
     * @param gameId Game ID
     * @return available Available balance for payouts
     */
    function playerMaxValue(uint256 gameId, address /* player */) external view returns (uint256 available) {
        Game memory game = games[gameId];
        if (game.totalDeposited >= game.reservedFee + game.totalPaidOut) {
            available = game.totalDeposited - game.reservedFee - game.totalPaidOut;
        } else {
            available = 0;
        }
    }

    /**
     * @notice Get available balance for payouts in a game
     * @param gameId Game ID
     * @return available Available balance (totalDeposited - reservedFee - totalPaidOut)
     */
    function availableBalance(uint256 gameId) external view returns (uint256 available) {
        Game memory game = games[gameId];
        // Reserved fee is accounting only, not yet transferred, so subtract it from available
        if (game.totalDeposited >= game.reservedFee + game.totalPaidOut) {
            available = game.totalDeposited - game.reservedFee - game.totalPaidOut;
        } else {
            available = 0;
        }
    }
}

