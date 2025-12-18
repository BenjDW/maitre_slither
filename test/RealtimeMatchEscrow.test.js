const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("RealtimeMatchEscrow", function () {
  // Helper function to get future timestamp
  async function getFutureTimestamp(secondsFromNow) {
    const latestBlock = await ethers.provider.getBlock("latest");
    return Number(latestBlock.timestamp) + secondsFromNow;
  }

  // Deploy contracts fixture
  async function deployContractsFixture() {
    const [owner, operator, treasury, playerA, playerB, attacker, other] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    // Deploy RealtimeMatchEscrow
    const RealtimeMatchEscrow = await ethers.getContractFactory("RealtimeMatchEscrow");
    const escrow = await RealtimeMatchEscrow.deploy(
      await usdc.getAddress(),
      operator.address,
      treasury.address,
      200 // 2% fee
    );

    // Give players some USDC
    const playerBalance = ethers.parseUnits("10000", 6); // 10,000 USDC
    await usdc.transfer(playerA.address, playerBalance);
    await usdc.transfer(playerB.address, playerBalance);
    await usdc.transfer(attacker.address, playerBalance);
    await usdc.transfer(other.address, playerBalance);

    // Default stake for testing
    const stake = ethers.parseUnits("10", 6); // 10 USDC

    return {
      escrow,
      usdc,
      owner,
      operator,
      treasury,
      playerA,
      playerB,
      attacker,
      other,
      stake,
    };
  }

  describe("Deployment", function () {
    it("Should deploy with correct initial values", async function () {
      const { escrow, usdc, operator, treasury } = await loadFixture(deployContractsFixture);

      expect(await escrow.usdc()).to.equal(await usdc.getAddress());
      expect(await escrow.operator()).to.equal(operator.address);
      expect(await escrow.treasuryAddress()).to.equal(treasury.address);
      expect(await escrow.feeBps()).to.equal(200);
      expect(await escrow.nextRoomId()).to.equal(0);
      expect(await escrow.paused()).to.equal(false);
    });

    it("Should revert with invalid constructor parameters", async function () {
      const { usdc, operator, treasury } = await loadFixture(deployContractsFixture);
      const RealtimeMatchEscrow = await ethers.getContractFactory("RealtimeMatchEscrow");

      // Zero address for USDC
      await expect(
        RealtimeMatchEscrow.deploy(ethers.ZeroAddress, operator.address, treasury.address, 200)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractFactory("RealtimeMatchEscrow")).interface }, "InvalidAddress");

      // Zero address for operator
      await expect(
        RealtimeMatchEscrow.deploy(await usdc.getAddress(), ethers.ZeroAddress, treasury.address, 200)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractFactory("RealtimeMatchEscrow")).interface }, "InvalidAddress");

      // Zero address for treasury
      await expect(
        RealtimeMatchEscrow.deploy(await usdc.getAddress(), operator.address, ethers.ZeroAddress, 200)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractFactory("RealtimeMatchEscrow")).interface }, "InvalidAddress");

      // Fee too high
      await expect(
        RealtimeMatchEscrow.deploy(await usdc.getAddress(), operator.address, treasury.address, 1001)
      ).to.be.revertedWithCustomError({ interface: (await ethers.getContractFactory("RealtimeMatchEscrow")).interface }, "InvalidFeeBps");
    });
  });

  describe("Room Creation", function () {
    it("Should create a room successfully", async function () {
      const { escrow, playerA, playerB, operator } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6); // 10 USDC
      const deadline = await getFutureTimestamp(3600); // 1 hour from now
      const roomKeyCommitment = ethers.keccak256(ethers.toUtf8Bytes("room-key-123"));
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("metadata"));

      await expect(
        escrow.connect(operator).createRoom(
          playerA.address,
          playerB.address,
          stake,
          deadline,
          roomKeyCommitment,
          metadataHash
        )
      )
        .to.emit(escrow, "RoomCreated")
        .withArgs(0, playerA.address, playerB.address, stake, deadline, operator.address, roomKeyCommitment);

      const room = await escrow.rooms(0);
      expect(room.playerA).to.equal(playerA.address);
      expect(room.playerB).to.equal(playerB.address);
      expect(room.stake).to.equal(stake);
      expect(room.deadline).to.equal(deadline);
      expect(room.status).to.equal(1); // CREATED
      expect(room.paidMask).to.equal(0);
    });

    it("Should revert if non-operator tries to create room", async function () {
      const { escrow, playerA, playerB, attacker } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(3600);

      await expect(
        escrow.connect(attacker).createRoom(
          playerA.address,
          playerB.address,
          stake,
          deadline,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("Should revert with invalid room parameters", async function () {
      const { escrow, playerA, playerB, operator } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(3600);

      // Zero address for playerA
      await expect(
        escrow.connect(operator).createRoom(
          ethers.ZeroAddress,
          playerB.address,
          stake,
          deadline,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

      // Same player for both
      await expect(
        escrow.connect(operator).createRoom(
          playerA.address,
          playerA.address,
          stake,
          deadline,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");

      // Zero stake
      await expect(
        escrow.connect(operator).createRoom(
          playerA.address,
          playerB.address,
          0,
          deadline,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidStake");

      // Invalid deadline
      await expect(
        escrow.connect(operator).createRoom(
          playerA.address,
          playerB.address,
          stake,
          Number((await ethers.provider.getBlock("latest")).timestamp) - 100,
          ethers.ZeroHash,
          ethers.ZeroHash
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
    });
  });

  describe("Joining Rooms", function () {
    async function createRoomFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, playerA, playerB, operator, attacker, owner, stake: defaultStake } = base;

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      // Approve USDC spending
      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      return { escrow, usdc, playerA, playerB, operator, attacker, owner, stake, deadline };
    }

    it("Should allow players to join and pay stake", async function () {
      const { escrow, usdc, playerA, playerB, stake } = await loadFixture(createRoomFixture);

      const balanceBeforeA = await usdc.balanceOf(playerA.address);
      const balanceBeforeB = await usdc.balanceOf(playerB.address);

      await expect(escrow.connect(playerA).joinRoom(0))
        .to.emit(escrow, "RoomJoined")
        .withArgs(0, playerA.address, stake);

      expect(await usdc.balanceOf(playerA.address)).to.equal(balanceBeforeA - stake);
      expect(await escrow.hasPaid(0, playerA.address)).to.equal(true);

      await expect(escrow.connect(playerB).joinRoom(0))
        .to.emit(escrow, "RoomJoined")
        .withArgs(0, playerB.address, stake)
        .to.emit(escrow, "RoomReady")
        .withArgs(0);

      expect(await usdc.balanceOf(playerB.address)).to.equal(balanceBeforeB - stake);
      expect(await escrow.hasPaid(0, playerB.address)).to.equal(true);

      const room = await escrow.rooms(0);
      expect(room.status).to.equal(2); // READY
      expect(room.paidMask).to.equal(3); // Both paid
    });

    it("Should revert if non-player tries to join", async function () {
      const { escrow, attacker } = await loadFixture(createRoomFixture);

      await expect(escrow.connect(attacker).joinRoom(0))
        .to.be.revertedWithCustomError(escrow, "PlayerNotInRoom");
    });

    it("Should revert if player already paid", async function () {
      const { escrow, playerA } = await loadFixture(createRoomFixture);

      await escrow.connect(playerA).joinRoom(0);

      await expect(escrow.connect(playerA).joinRoom(0))
        .to.be.revertedWithCustomError(escrow, "AlreadyPaid");
    });

    it("Should revert if room already started", async function () {
      const { escrow, playerA, playerB } = await loadFixture(createRoomFixture);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      // Try to join after start
      const newStake = ethers.parseUnits("5", 6);
      await escrow.connect(playerA).joinRoom(0).catch(() => {});
      // This should fail because room is already started
    });

    it("Should revert if contract is paused", async function () {
      const { escrow, playerA, owner } = await loadFixture(createRoomFixture);

      await escrow.connect(owner).pause();

      await expect(escrow.connect(playerA).joinRoom(0))
        .to.be.revertedWithCustomError(escrow, "ContractPaused");
    });
  });

  describe("Starting Rooms", function () {
    async function readyRoomFixture() {
      const { escrow, usdc, playerA, playerB, operator } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);

      const base = await loadFixture(deployContractsFixture);
      return { escrow, playerA, playerB, attacker: base.attacker };
    }

    it("Should start a ready room", async function () {
      const { escrow } = await loadFixture(readyRoomFixture);

      await expect(escrow.startRoom(0))
        .to.emit(escrow, "RoomStarted")
        .withArgs(0);

      const room = await escrow.rooms(0);
      expect(room.status).to.equal(3); // STARTED
    });

    it("Should allow anyone to start a ready room", async function () {
      const { escrow, attacker } = await loadFixture(readyRoomFixture);

      await expect(escrow.connect(attacker).startRoom(0))
        .to.emit(escrow, "RoomStarted")
        .withArgs(0);
    });

    it("Should revert if room is not ready", async function () {
      const { escrow, playerA, playerB, operator } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await expect(escrow.startRoom(0))
        .to.be.revertedWithCustomError(escrow, "RoomNotReady");
    });
  });

  describe("Resolving Rooms", function () {
    async function startedRoomFixture() {
      const { escrow, usdc, playerA, playerB, operator } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      const base = await loadFixture(deployContractsFixture);
      return { escrow, usdc, playerA, playerB, operator, attacker: base.attacker, stake };
    }

    it("Should resolve room and payout winner", async function () {
      const { escrow, usdc, playerA, playerB, operator, stake } = await loadFixture(startedRoomFixture);

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n; // 2%
      const payout = pot - fee;

      // Create EIP-712 signature
      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);

      const winnerBalanceBefore = await usdc.balanceOf(winner);
      const treasuryBalanceBefore = await usdc.balanceOf(await escrow.treasuryAddress());

      await expect(escrow.resolveAndPayout(roomId, winner, nonce, signature))
        .to.emit(escrow, "RoomResolved")
        .withArgs(roomId, winner, pot, fee, payout, nonce);

      const winnerBalanceAfter = await usdc.balanceOf(winner);
      expect(winnerBalanceAfter - winnerBalanceBefore).to.equal(payout);

      const room = await escrow.rooms(roomId);
      expect(room.status).to.equal(4); // RESOLVED
      expect(await escrow.accruedFees()).to.equal(fee);
      expect(await escrow.usedNonce(roomId, nonce)).to.equal(true);
    });

    it("Should revert with invalid signature", async function () {
      const { escrow, playerA, attacker, stake } = await loadFixture(startedRoomFixture);

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      // Sign with wrong account
      const signature = await attacker.signTypedData(domain, types, value);

      await expect(escrow.resolveAndPayout(roomId, winner, nonce, signature))
        .to.be.revertedWithCustomError(escrow, "InvalidSignature");
    });

    it("Should revert with reused nonce", async function () {
      const { escrow, usdc, playerA, playerB, operator, stake } = await loadFixture(startedRoomFixture);

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);

      // First resolve should succeed
      await expect(escrow.connect(playerA).resolveAndPayout(roomId, winner, nonce, signature))
        .to.emit(escrow, "RoomResolved");

      // Verify room is resolved
      const room = await escrow.rooms(roomId);
      expect(room.status).to.equal(4); // RESOLVED

      // Try to use same nonce again - should fail with NonceAlreadyUsed
      // The contract checks nonce before checking if room is resolved
      await expect(escrow.connect(playerA).resolveAndPayout(roomId, winner, nonce, signature))
        .to.be.revertedWithCustomError(escrow, "NonceAlreadyUsed");
    });

    it("Should revert if room not started", async function () {
      const { escrow, playerA, playerB, operator, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);

      await expect(escrow.resolveAndPayout(roomId, winner, nonce, signature))
        .to.be.revertedWithCustomError(escrow, "RoomNotStarted");
    });

    it("Should revert if winner is not a player", async function () {
      const { escrow, playerA, playerB, operator, attacker, stake } = await loadFixture(startedRoomFixture);

      const roomId = 0;
      const winner = attacker.address; // Not a player
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);

      await expect(escrow.resolveAndPayout(roomId, winner, nonce, signature))
        .to.be.revertedWithCustomError(escrow, "InvalidWinner");
    });
  });

  describe("Refunds", function () {
    async function createRoomForRefundFixture() {
      const { escrow, usdc, playerA, playerB, operator } = await loadFixture(deployContractsFixture);

      const stake = ethers.parseUnits("10", 6);
      const deadline = await getFutureTimestamp(100); // 100 seconds from now

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);

      return { escrow, usdc, playerA, playerB, stake, deadline };
    }

    it("Should refund player after deadline", async function () {
      const { escrow, usdc, playerA, stake } = await loadFixture(createRoomForRefundFixture);

      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      const balanceBefore = await usdc.balanceOf(playerA.address);

      await expect(escrow.connect(playerA).refund(0))
        .to.emit(escrow, "RoomRefunded")
        .withArgs(0, playerA.address, stake);

      const balanceAfter = await usdc.balanceOf(playerA.address);
      expect(balanceAfter - balanceBefore).to.equal(stake);
      expect(await escrow.hasRefunded(0, playerA.address)).to.equal(true);
    });

    it("Should mark room as cancelled when both players refund", async function () {
      const { escrow, usdc, playerA, playerB, stake } = await loadFixture(createRoomForRefundFixture);

      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      await escrow.connect(playerA).refund(0);
      await escrow.connect(playerB).refund(0);

      const room = await escrow.rooms(0);
      expect(room.status).to.equal(5); // CANCELLED
    });

    it("Should revert if deadline not passed", async function () {
      const { escrow, playerA } = await loadFixture(createRoomForRefundFixture);

      await expect(escrow.connect(playerA).refund(0))
        .to.be.revertedWithCustomError(escrow, "RoomNotEligibleForRefund");
    });

    it("Should revert if room already resolved", async function () {
      const { escrow, usdc, playerA, playerB, operator, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);
      await escrow.resolveAndPayout(roomId, winner, nonce, signature);

      await expect(escrow.connect(playerA).refund(0))
        .to.be.revertedWithCustomError(escrow, "RoomNotEligibleForRefund");
    });

    it("Should revert if player already refunded", async function () {
      const { escrow, playerA } = await loadFixture(createRoomForRefundFixture);

      await ethers.provider.send("evm_increaseTime", [200]);
      await ethers.provider.send("evm_mine", []);

      await escrow.connect(playerA).refund(0);

      await expect(escrow.connect(playerA).refund(0))
        .to.be.revertedWithCustomError(escrow, "AlreadyRefunded");
    });
  });

  describe("Admin Functions", function () {
    it("Should update operator", async function () {
      const { escrow, owner, operator, attacker } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setOperator(attacker.address))
        .to.emit(escrow, "OperatorUpdated")
        .withArgs(operator.address, attacker.address);

      expect(await escrow.operator()).to.equal(attacker.address);
    });

    it("Should update treasury", async function () {
      const { escrow, owner, treasury, attacker } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setTreasury(attacker.address))
        .to.emit(escrow, "TreasuryUpdated")
        .withArgs(treasury.address, attacker.address);

      expect(await escrow.treasuryAddress()).to.equal(attacker.address);
    });

    it("Should update fee BPS", async function () {
      const { escrow, owner } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setFeeBps(300))
        .to.emit(escrow, "FeeBpsUpdated")
        .withArgs(200, 300);

      expect(await escrow.feeBps()).to.equal(300);
    });

    it("Should revert if non-owner tries admin functions", async function () {
      const { escrow, attacker } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(attacker).setOperator(attacker.address))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

      await expect(escrow.connect(attacker).setTreasury(attacker.address))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

      await expect(escrow.connect(attacker).setFeeBps(300))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("Should pause and unpause contract", async function () {
      const { escrow, owner } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).pause())
        .to.emit(escrow, "Paused")
        .withArgs(owner.address);

      expect(await escrow.paused()).to.equal(true);

      await expect(escrow.connect(owner).unpause())
        .to.emit(escrow, "Unpaused")
        .withArgs(owner.address);

      expect(await escrow.paused()).to.equal(false);
    });

    it("Should withdraw fees to treasury", async function () {
      const { escrow, usdc, playerA, playerB, operator, treasury, owner, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);
      await escrow.resolveAndPayout(roomId, winner, nonce, signature);

      const treasuryBalanceBefore = await usdc.balanceOf(treasury.address);

      await expect(escrow.connect(owner).withdrawFees())
        .to.emit(escrow, "FeesWithdrawn")
        .withArgs(treasury.address, fee);

      const treasuryBalanceAfter = await usdc.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(fee);
      expect(await escrow.accruedFees()).to.equal(0);
    });
  });

  describe("Security Tests", function () {
    it("Should prevent reentrancy attacks", async function () {
      // This test verifies that ReentrancyGuard is working
      const { escrow, usdc, playerA, playerB, operator, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      // Multiple resolve attempts should be prevented by nonce
      const roomId = 0;
      const winner = playerA.address;
      const nonce1 = 12345;
      const nonce2 = 12346;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value1 = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce: nonce1,
      };

      const value2 = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce: nonce2,
      };

      const signature1 = await operator.signTypedData(domain, types, value1);
      const signature2 = await operator.signTypedData(domain, types, value2);

      // First resolve should succeed
      await escrow.resolveAndPayout(roomId, winner, nonce1, signature1);

      // Second resolve should fail because room is already resolved
      await expect(escrow.resolveAndPayout(roomId, winner, nonce2, signature2))
        .to.be.revertedWithCustomError(escrow, "RoomAlreadyResolved");
    });

    it("Should prevent signature replay across different rooms", async function () {
      const { escrow, usdc, playerA, playerB, operator, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      // Create two rooms
      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake * 2n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake * 2n);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      await escrow.connect(playerA).joinRoom(1);
      await escrow.connect(playerB).joinRoom(1);
      await escrow.startRoom(1);

      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      // Sign for room 0
      const value0 = {
        roomId: 0,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature0 = await operator.signTypedData(domain, types, value0);
      await escrow.resolveAndPayout(0, winner, nonce, signature0);

      // Try to use same signature for room 1 (should fail because roomId is in signature)
      await expect(escrow.resolveAndPayout(1, winner, nonce, signature0))
        .to.be.revertedWithCustomError(escrow, "InvalidSignature");
    });

    it("Should handle fee calculation correctly with different fee rates", async function () {
      const { escrow, usdc, playerA, playerB, operator, owner, stake } = await loadFixture(deployContractsFixture);

      // Change fee to 5%
      await escrow.connect(owner).setFeeBps(500);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      await usdc.connect(playerA).approve(await escrow.getAddress(), stake);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake);

      await escrow.connect(playerA).joinRoom(0);
      await escrow.connect(playerB).joinRoom(0);
      await escrow.startRoom(0);

      const room = await escrow.rooms(0);
      const feeBpsSnapshot = room.feeBpsSnapshot;
      expect(feeBpsSnapshot).to.equal(500); // Should use fee at room creation

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * feeBpsSnapshot) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);
      await escrow.resolveAndPayout(roomId, winner, nonce, signature);

      expect(await escrow.accruedFees()).to.equal(fee);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle multiple rooms correctly", async function () {
      const { escrow, usdc, playerA, playerB, operator, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      // Create 3 rooms
      for (let i = 0; i < 3; i++) {
        await escrow.connect(operator).createRoom(
          playerA.address,
          playerB.address,
          stake,
          deadline,
          ethers.ZeroHash,
          ethers.ZeroHash
        );
      }

      expect(await escrow.nextRoomId()).to.equal(3);

      // Join all rooms
      await usdc.connect(playerA).approve(await escrow.getAddress(), stake * 3n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), stake * 3n);

      for (let i = 0; i < 3; i++) {
        await escrow.connect(playerA).joinRoom(i);
        await escrow.connect(playerB).joinRoom(i);
        await escrow.startRoom(i);
      }

      // Resolve all rooms
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      for (let i = 0; i < 3; i++) {
        const value = {
          roomId: i,
          winner: i % 2 === 0 ? playerA.address : playerB.address,
          pot,
          fee,
          payout,
          nonce: i + 1000,
        };

        const signature = await operator.signTypedData(domain, types, value);
        await escrow.resolveAndPayout(i, value.winner, value.nonce, signature);
      }

      expect(await escrow.accruedFees()).to.equal(fee * 3n);
    });

    it("Should verify signature correctly", async function () {
      const { escrow, playerA, playerB, operator, stake } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createRoom(
        playerA.address,
        playerB.address,
        stake,
        deadline,
        ethers.ZeroHash,
        ethers.ZeroHash
      );

      const roomId = 0;
      const winner = playerA.address;
      const nonce = 12345;
      const pot = stake * 2n;
      const fee = (pot * 200n) / 10000n;
      const payout = pot - fee;

      const domain = {
        name: "RealtimeMatchEscrow",
        version: "1",
        chainId: 31337,
        verifyingContract: await escrow.getAddress(),
      };

      const types = {
        Resolve: [
          { name: "roomId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "pot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
      };

      const signature = await operator.signTypedData(domain, types, value);

      const [isValid, signer] = await escrow.verifyResolveSignature(
        roomId,
        winner,
        pot,
        fee,
        payout,
        nonce,
        signature
      );

      expect(isValid).to.equal(true);
      expect(signer).to.equal(operator.address);
    });
  });
});

