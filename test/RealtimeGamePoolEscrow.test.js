const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("RealtimeGamePoolEscrow", function () {
  // Helper function to get future timestamp
  async function getFutureTimestamp(secondsFromNow) {
    const latestBlock = await ethers.provider.getBlock("latest");
    return Number(latestBlock.timestamp) + secondsFromNow;
  }

  // Deploy contracts fixture
  async function deployContractsFixture() {
    const [owner, operator, treasury, playerA, playerB, playerC, playerD, attacker, other] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    // Deploy RealtimeGamePoolEscrow
    const RealtimeGamePoolEscrow = await ethers.getContractFactory("RealtimeGamePoolEscrow");
    const escrow = await RealtimeGamePoolEscrow.deploy(
      await usdc.getAddress(),
      operator.address,
      treasury.address,
      200 // 2% fee
    );

    // Give players some USDC
    const playerBalance = ethers.parseUnits("100000", 6); // 100,000 USDC
    await usdc.transfer(playerA.address, playerBalance);
    await usdc.transfer(playerB.address, playerBalance);
    await usdc.transfer(playerC.address, playerBalance);
    await usdc.transfer(playerD.address, playerBalance);
    await usdc.transfer(attacker.address, playerBalance);
    await usdc.transfer(other.address, playerBalance);

    // Default buy-in for testing
    const buyIn = ethers.parseUnits("100", 6); // 100 USDC

    return {
      escrow,
      usdc,
      owner,
      operator,
      treasury,
      playerA,
      playerB,
      playerC,
      playerD,
      attacker,
      other,
      buyIn,
    };
  }

  describe("Deployment", function () {
    it("Should deploy with correct initial values", async function () {
      const { escrow, usdc, operator, treasury } = await loadFixture(deployContractsFixture);

      expect(await escrow.usdc()).to.equal(await usdc.getAddress());
      expect(await escrow.operator()).to.equal(operator.address);
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await escrow.feeBps()).to.equal(200);
      expect(await escrow.nextGameId()).to.equal(0);
      expect(await escrow.accruedFees()).to.equal(0);
    });

    it("Should revert with invalid constructor parameters", async function () {
      const { usdc, operator, treasury } = await loadFixture(deployContractsFixture);
      const RealtimeGamePoolEscrow = await ethers.getContractFactory("RealtimeGamePoolEscrow");

      // Zero address for USDC
      await expect(
        RealtimeGamePoolEscrow.deploy(ethers.ZeroAddress, operator.address, treasury.address, 200)
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("RealtimeGamePoolEscrow")).interface },
        "InvalidAddress"
      );

      // Zero address for operator
      await expect(
        RealtimeGamePoolEscrow.deploy(await usdc.getAddress(), ethers.ZeroAddress, treasury.address, 200)
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("RealtimeGamePoolEscrow")).interface },
        "InvalidAddress"
      );

      // Zero address for treasury
      await expect(
        RealtimeGamePoolEscrow.deploy(await usdc.getAddress(), operator.address, ethers.ZeroAddress, 200)
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("RealtimeGamePoolEscrow")).interface },
        "InvalidAddress"
      );

      // Fee too high
      await expect(
        RealtimeGamePoolEscrow.deploy(await usdc.getAddress(), operator.address, treasury.address, 1001)
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("RealtimeGamePoolEscrow")).interface },
        "InvalidFeeBps"
      );
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

      expect(await escrow.treasury()).to.equal(attacker.address);
    });

    it("Should update fee BPS", async function () {
      const { escrow, owner } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setFeeBps(300))
        .to.emit(escrow, "FeeBpsUpdated")
        .withArgs(200, 300);

      expect(await escrow.feeBps()).to.equal(300);
    });

    it("Should revert if fee BPS too high", async function () {
      const { escrow, owner } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setFeeBps(1001))
        .to.be.revertedWithCustomError(escrow, "InvalidFeeBps");
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

    it("Should revert with zero address for operator", async function () {
      const { escrow, owner } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setOperator(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("Should revert with zero address for treasury", async function () {
      const { escrow, owner } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(owner).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(escrow, "ZeroTreasury");
    });
  });

  describe("Game Creation", function () {
    it("Should create a game successfully", async function () {
      const { escrow, operator, buyIn } = await loadFixture(deployContractsFixture);

      const targetPlayers = 4;
      const deadline = await getFutureTimestamp(3600); // 1 hour from now

      await expect(escrow.connect(operator).createGame(buyIn, targetPlayers, deadline))
        .to.emit(escrow, "GameCreated")
        .withArgs(0, buyIn, targetPlayers, deadline);

      const game = await escrow.games(0);
      expect(game.buyIn).to.equal(buyIn);
      expect(game.targetPlayers).to.equal(targetPlayers);
      expect(game.joinDeadline).to.equal(deadline);
      expect(game.status).to.equal(1); // WAITING
      expect(game.totalDeposited).to.equal(0);
      expect(game.potAtStart).to.equal(0);
      expect(game.reservedFee).to.equal(0);
      expect(game.totalPaidOut).to.equal(0);

      expect(await escrow.nextGameId()).to.equal(1);
    });

    it("Should create multiple games with auto-incrementing IDs", async function () {
      const { escrow, operator, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await escrow.connect(operator).createGame(buyIn, 4, deadline);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      expect(await escrow.nextGameId()).to.equal(3);
    });

    it("Should revert if non-operator tries to create game", async function () {
      const { escrow, attacker, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      await expect(escrow.connect(attacker).createGame(buyIn, 4, deadline))
        .to.be.revertedWithCustomError(escrow, "NotOperator");
    });

    it("Should revert with invalid game parameters", async function () {
      const { escrow, operator } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      // Zero buy-in
      await expect(escrow.connect(operator).createGame(0, 4, deadline))
        .to.be.revertedWithCustomError(escrow, "InvalidBuyIn");

      // Zero target players
      await expect(escrow.connect(operator).createGame(ethers.parseUnits("100", 6), 0, deadline))
        .to.be.revertedWithCustomError(escrow, "InvalidTargetPlayers");

      // Invalid deadline (past)
      const pastDeadline = (await ethers.provider.getBlock("latest")).timestamp - 100;
      await expect(escrow.connect(operator).createGame(ethers.parseUnits("100", 6), 4, pastDeadline))
        .to.be.revertedWithCustomError(escrow, "InvalidDeadline");
    });
  });

  describe("Joining Games", function () {
    async function createGameFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      // Approve USDC spending
      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      return { ...base, deadline };
    }

    it("Should allow players to join game", async function () {
      const { escrow, usdc, playerA, buyIn } = await loadFixture(createGameFixture);

      const balanceBefore = await usdc.balanceOf(playerA.address);
      const escrowBalanceBefore = await usdc.balanceOf(await escrow.getAddress());

      await expect(escrow.connect(playerA).joinGame(0))
        .to.emit(escrow, "PlayerJoined")
        .withArgs(0, playerA.address, buyIn, buyIn);

      expect(await usdc.balanceOf(playerA.address)).to.equal(balanceBefore - buyIn);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(escrowBalanceBefore + buyIn);

      const game = await escrow.games(0);
      expect(game.totalDeposited).to.equal(buyIn);
      expect(await escrow.playerDeposited(0, playerA.address)).to.equal(buyIn);
      expect(await escrow.playerActive(0, playerA.address)).to.equal(true);
      expect(await escrow.playerEverJoined(0, playerA.address)).to.equal(true);
      expect(await escrow.activePlayerCount(0)).to.equal(1);
    });

    it("Should allow multiple players to join", async function () {
      const { escrow, playerA, playerB, playerC, playerD, buyIn } = await loadFixture(createGameFixture);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(playerC).joinGame(0);
      await escrow.connect(playerD).joinGame(0);

      const game = await escrow.games(0);
      expect(game.totalDeposited).to.equal(buyIn * 4n);
      expect(await escrow.activePlayerCount(0)).to.equal(4);
      expect(game.status).to.equal(2); // FULL
    });

    it("Should emit GameFull when target players reached", async function () {
      const { escrow, playerA, playerB, playerC, playerD } = await loadFixture(createGameFixture);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(playerC).joinGame(0);

      await expect(escrow.connect(playerD).joinGame(0))
        .to.emit(escrow, "GameFull")
        .withArgs(0);
    });

    it("Should revert if game doesn't exist", async function () {
      const { escrow, playerA } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(playerA).joinGame(999))
        .to.be.revertedWithCustomError(escrow, "InvalidGame");
    });

    it("Should revert if game already started", async function () {
      const { escrow, operator, playerA, playerB, playerC, playerD } = await loadFixture(createGameFixture);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(operator).startGame(0);

      await expect(escrow.connect(playerC).joinGame(0))
        .to.be.revertedWithCustomError(escrow, "GameNotWaiting");
    });

    it("Should revert if deadline passed", async function () {
      const { escrow, usdc, operator, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const currentTime = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const deadline = currentTime + 100n;
      await escrow.connect(operator).createGame(buyIn, 4, Number(deadline));

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn);

      // Fast forward time past deadline
      await time.increaseTo(Number(deadline) + 1);

      await expect(escrow.connect(playerA).joinGame(0))
        .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("Should revert if insufficient USDC allowance", async function () {
      const { escrow, usdc, operator, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      // Don't approve - should revert on transfer
      await expect(escrow.connect(playerA).joinGame(0))
        .to.be.reverted;
    });
  });

  describe("Starting Games", function () {
    async function playersJoinedFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);
      await escrow.connect(base.playerC).joinGame(0);
      await escrow.connect(base.playerD).joinGame(0);

      return { ...base };
    }

    it("Should start a game successfully", async function () {
      const { escrow, operator, buyIn } = await loadFixture(playersJoinedFixture);

      const gameBefore = await escrow.games(0);
      const totalDeposited = buyIn * 4n;
      const expectedFee = (totalDeposited * 200n) / 10000n; // 2%

      await expect(escrow.connect(operator).startGame(0))
        .to.emit(escrow, "GameStarted")
        .withArgs(0, totalDeposited, expectedFee, 200);

      const game = await escrow.games(0);
      expect(game.status).to.equal(3); // LIVE
      expect(game.potAtStart).to.equal(totalDeposited);
      expect(game.reservedFee).to.equal(expectedFee);
    });

    it("Should start game even if not full", async function () {
      const { escrow, usdc, operator, playerA, playerB, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);

      await expect(escrow.connect(operator).startGame(0))
        .to.emit(escrow, "GameStarted");

      const game = await escrow.games(0);
      expect(game.status).to.equal(3); // LIVE
    });

    it("Should revert if non-operator tries to start game", async function () {
      const { escrow, attacker } = await loadFixture(playersJoinedFixture);

      await expect(escrow.connect(attacker).startGame(0))
        .to.be.revertedWithCustomError(escrow, "NotOperator");
    });

    it("Should revert if game doesn't exist", async function () {
      const { escrow, operator } = await loadFixture(deployContractsFixture);

      await expect(escrow.connect(operator).startGame(999))
        .to.be.revertedWithCustomError(escrow, "InvalidGame");
    });

    it("Should revert if game already started", async function () {
      const { escrow, operator } = await loadFixture(playersJoinedFixture);

      await escrow.connect(operator).startGame(0);

      await expect(escrow.connect(operator).startGame(0))
        .to.be.revertedWithCustomError(escrow, "GameNotWaiting");
    });
  });

  describe("Death Exit Settlement", function () {
    async function liveGameFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);
      await escrow.connect(base.playerC).joinGame(0);
      await escrow.connect(base.playerD).joinGame(0);

      await escrow.connect(operator).startGame(0);

      return { ...base };
    }

    it("Should settle death exit with 50% payout", async function () {
      const { escrow, usdc, operator, playerA, buyIn } = await loadFixture(liveGameFixture);

      const value = buyIn; // 100 USDC
      const expectedPayout = value / 2n; // 50 USDC
      const eventId = 1;

      const balanceBefore = await usdc.balanceOf(playerA.address);
      const gameBefore = await escrow.games(0);

      await expect(escrow.connect(operator).settleDeathExit(0, playerA.address, value, eventId))
        .to.emit(escrow, "PlayerDeathSettled")
        .withArgs(0, playerA.address, value, expectedPayout, eventId);

      const balanceAfter = await usdc.balanceOf(playerA.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedPayout);

      const game = await escrow.games(0);
      expect(game.totalPaidOut).to.equal(gameBefore.totalPaidOut + expectedPayout);
      expect(await escrow.playerActive(0, playerA.address)).to.equal(false);
      expect(await escrow.playerExited(0, playerA.address)).to.equal(true);
      expect(await escrow.activePlayerCount(0)).to.equal(3);
      expect(await escrow.usedEventId(0, eventId)).to.equal(true);
    });

    it("Should allow value higher than deposit (no cap)", async function () {
      const { escrow, usdc, operator, playerA, playerB, buyIn } = await loadFixture(liveGameFixture);

      // Player A dies first, leaving 50% in pool
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Player B now has value higher than deposit (gained from A's death)
      const value = buyIn * 2n; // 200 USDC (double the deposit)
      const expectedPayout = value / 2n; // 100 USDC

      const balanceBefore = await usdc.balanceOf(playerB.address);

      await expect(escrow.connect(operator).settleDeathExit(0, playerB.address, value, 2))
        .to.emit(escrow, "PlayerDeathSettled")
        .withArgs(0, playerB.address, value, expectedPayout, 2);

      const balanceAfter = await usdc.balanceOf(playerB.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedPayout);
    });

    it("Should revert if game not live", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await expect(escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1))
        .to.be.revertedWithCustomError(escrow, "GameNotLive");
    });

    it("Should revert if player not active", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(liveGameFixture);

      // First settle the player
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Try to settle again
      await expect(escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 2))
        .to.be.revertedWithCustomError(escrow, "PlayerNotActive");
    });

    it("Should revert if player already exited", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(liveGameFixture);

      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Try to settle again with different eventId
      await expect(escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 2))
        .to.be.revertedWithCustomError(escrow, "PlayerNotActive");
    });

    it("Should revert if eventId already used", async function () {
      const { escrow, operator, playerA, playerB, buyIn } = await loadFixture(liveGameFixture);

      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Try to use same eventId for different player
      await expect(escrow.connect(operator).settleDeathExit(0, playerB.address, buyIn, 1))
        .to.be.revertedWithCustomError(escrow, "EventIdAlreadyUsed");
    });

    it("Should revert if value is zero", async function () {
      const { escrow, operator, playerA } = await loadFixture(liveGameFixture);

      await expect(escrow.connect(operator).settleDeathExit(0, playerA.address, 0, 1))
        .to.be.revertedWithCustomError(escrow, "InvalidValue");
    });

    it("Should revert if insufficient funds", async function () {
      const { escrow, operator, playerA, playerB, playerC, buyIn } = await loadFixture(liveGameFixture);

      // Settle first 2 players normally to reduce available funds
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);
      await escrow.connect(operator).settleDeathExit(0, playerB.address, buyIn, 2);

      // Get remaining available funds after settlements
      const remainingAvailable = await escrow.availableBalance(0);
      
      // Ensure there's some funds left but not enough for a large settlement
      expect(remainingAvailable).to.be.greaterThan(0);

      // Try to settle 3rd player with value that would require payout > remainingAvailable
      // For death exit, payout = value / 2, so if payout > remainingAvailable, then value > remainingAvailable * 2
      const excessiveValue = remainingAvailable * 2n + buyIn; // Definitely more than available

      await expect(escrow.connect(operator).settleDeathExit(0, playerC.address, excessiveValue, 3))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds");
    });

    it("Should revert if non-operator tries to settle", async function () {
      const { escrow, attacker, playerA, buyIn } = await loadFixture(liveGameFixture);

      await expect(escrow.connect(attacker).settleDeathExit(0, playerA.address, buyIn, 1))
        .to.be.revertedWithCustomError(escrow, "NotOperator");
    });
  });

  describe("Alive Exit Settlement", function () {
    async function liveGameFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);
      await escrow.connect(base.playerC).joinGame(0);
      await escrow.connect(base.playerD).joinGame(0);

      await escrow.connect(operator).startGame(0);

      return { ...base };
    }

    it("Should settle alive exit with 100% payout", async function () {
      const { escrow, usdc, operator, playerA, buyIn } = await loadFixture(liveGameFixture);

      const value = buyIn; // 100 USDC
      const expectedPayout = value; // 100 USDC (100%)
      const eventId = 1;

      const balanceBefore = await usdc.balanceOf(playerA.address);
      const gameBefore = await escrow.games(0);

      await expect(escrow.connect(operator).settleAliveExit(0, playerA.address, value, eventId))
        .to.emit(escrow, "PlayerAliveSettled")
        .withArgs(0, playerA.address, value, expectedPayout, eventId);

      const balanceAfter = await usdc.balanceOf(playerA.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedPayout);

      const game = await escrow.games(0);
      expect(game.totalPaidOut).to.equal(gameBefore.totalPaidOut + expectedPayout);
      expect(await escrow.playerActive(0, playerA.address)).to.equal(false);
      expect(await escrow.playerExited(0, playerA.address)).to.equal(true);
      expect(await escrow.activePlayerCount(0)).to.equal(3);
      expect(await escrow.usedEventId(0, eventId)).to.equal(true);
    });

    it("Should allow value higher than deposit (no cap)", async function () {
      const { escrow, usdc, operator, playerA, playerB, buyIn } = await loadFixture(liveGameFixture);

      // Player A dies first, leaving 50% in pool
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Player B now has value higher than deposit (gained from A's death)
      const value = buyIn * 2n; // 200 USDC (double the deposit)
      const expectedPayout = value; // 200 USDC (100%)

      const balanceBefore = await usdc.balanceOf(playerB.address);

      await expect(escrow.connect(operator).settleAliveExit(0, playerB.address, value, 2))
        .to.emit(escrow, "PlayerAliveSettled")
        .withArgs(0, playerB.address, value, expectedPayout, 2);

      const balanceAfter = await usdc.balanceOf(playerB.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedPayout);
    });

    it("Should revert if game not live", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await expect(escrow.connect(operator).settleAliveExit(0, playerA.address, buyIn, 1))
        .to.be.revertedWithCustomError(escrow, "GameNotLive");
    });

    it("Should revert if player not active", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(liveGameFixture);

      // First settle the player
      await escrow.connect(operator).settleAliveExit(0, playerA.address, buyIn, 1);

      // Try to settle again
      await expect(escrow.connect(operator).settleAliveExit(0, playerA.address, buyIn, 2))
        .to.be.revertedWithCustomError(escrow, "PlayerNotActive");
    });

    it("Should revert if eventId already used", async function () {
      const { escrow, operator, playerA, playerB, buyIn } = await loadFixture(liveGameFixture);

      await escrow.connect(operator).settleAliveExit(0, playerA.address, buyIn, 1);

      // Try to use same eventId for different player
      await expect(escrow.connect(operator).settleAliveExit(0, playerB.address, buyIn, 1))
        .to.be.revertedWithCustomError(escrow, "EventIdAlreadyUsed");
    });

    it("Should revert if value is zero", async function () {
      const { escrow, operator, playerA } = await loadFixture(liveGameFixture);

      await expect(escrow.connect(operator).settleAliveExit(0, playerA.address, 0, 1))
        .to.be.revertedWithCustomError(escrow, "InvalidValue");
    });

    it("Should revert if insufficient funds", async function () {
      const { escrow, operator, playerA, playerB, playerC, playerD, buyIn } = await loadFixture(liveGameFixture);

      // Get available funds
      const game = await escrow.games(0);
      const available = game.totalDeposited - game.reservedFee - game.totalPaidOut;

      // Settle first 3 players with values that use up most funds
      const valuePerPlayer = available / 3n;
      await escrow.connect(operator).settleAliveExit(0, playerA.address, valuePerPlayer, 1);
      await escrow.connect(operator).settleAliveExit(0, playerB.address, valuePerPlayer, 2);
      await escrow.connect(operator).settleAliveExit(0, playerC.address, valuePerPlayer, 3);

      // Now try to settle last player with value that exceeds remaining available funds
      const remainingAvailable = await escrow.availableBalance(0);
      const excessiveValue = remainingAvailable * 2n + 1n; // More than double what's available

      await expect(escrow.connect(operator).settleAliveExit(0, playerD.address, excessiveValue, 4))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds");
    });
  });

  describe("Revive Functionality", function () {
    async function playerDiedFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);
      await escrow.connect(base.playerC).joinGame(0);
      await escrow.connect(base.playerD).joinGame(0);

      await escrow.connect(operator).startGame(0);

      // Player A dies
      await escrow.connect(operator).settleDeathExit(0, base.playerA.address, buyIn, 1);

      return { ...base };
    }

    it("Should allow player to revive after death", async function () {
      const { escrow, usdc, operator, playerA, buyIn } = await loadFixture(playerDiedFixture);

      const balanceBefore = await usdc.balanceOf(playerA.address);
      const gameBefore = await escrow.games(0);
      const depositedBefore = await escrow.playerDeposited(0, playerA.address);

      await expect(escrow.connect(playerA).revive(0))
        .to.emit(escrow, "PlayerRevived")
        .withArgs(0, playerA.address, buyIn, depositedBefore + buyIn)
        .to.emit(escrow, "PlayerJoined")
        .withArgs(0, playerA.address, buyIn, depositedBefore + buyIn);

      const balanceAfter = await usdc.balanceOf(playerA.address);
      expect(balanceBefore - balanceAfter).to.equal(buyIn);

      const game = await escrow.games(0);
      expect(game.totalDeposited).to.equal(gameBefore.totalDeposited + buyIn);
      expect(await escrow.playerDeposited(0, playerA.address)).to.equal(depositedBefore + buyIn);
      expect(await escrow.playerActive(0, playerA.address)).to.equal(true);
      expect(await escrow.playerExited(0, playerA.address)).to.equal(false);
      expect(await escrow.activePlayerCount(0)).to.equal(4);
    });

    it("Should allow multiple revives", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(playerDiedFixture);

      // First revive
      await escrow.connect(playerA).revive(0);
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn * 2n, 2);

      // Second revive
      await escrow.connect(playerA).revive(0);

      expect(await escrow.playerDeposited(0, playerA.address)).to.equal(buyIn * 3n); // Initial + 2 revives
      expect(await escrow.playerActive(0, playerA.address)).to.equal(true);
    });

    it("Should revert if game not live", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await expect(escrow.connect(playerA).revive(0))
        .to.be.revertedWithCustomError(escrow, "GameNotLive");
    });

    it("Should revert if player never joined", async function () {
      const { escrow, usdc, operator, playerA, other, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(operator).startGame(0);
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Other player never joined, try to revive
      await usdc.connect(other).approve(await escrow.getAddress(), buyIn);
      await expect(escrow.connect(other).revive(0))
        .to.be.revertedWithCustomError(escrow, "PlayerNotActive");
    });

    it("Should revert if player hasn't exited", async function () {
      const { escrow, playerB } = await loadFixture(playerDiedFixture);

      // Player B joined but hasn't exited, try to revive
      await expect(escrow.connect(playerB).revive(0))
        .to.be.revertedWithCustomError(escrow, "PlayerNotExited");
    });

    it("Should revert if player hasn't exited", async function () {
      const { escrow, playerB } = await loadFixture(playerDiedFixture);

      // Player B is still active, try to revive
      await expect(escrow.connect(playerB).revive(0))
        .to.be.revertedWithCustomError(escrow, "PlayerNotExited");
    });

    it("Should revert if player already active", async function () {
      const { escrow, operator, playerA, buyIn } = await loadFixture(playerDiedFixture);

      // Revive once
      await escrow.connect(playerA).revive(0);

      // Player is now active, try to revive again (should fail because not exited)
      await expect(escrow.connect(playerA).revive(0))
        .to.be.revertedWithCustomError(escrow, "PlayerNotExited");
    });
  });

  describe("Ending Games", function () {
    async function liveGameFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);
      await escrow.connect(base.playerC).joinGame(0);
      await escrow.connect(base.playerD).joinGame(0);

      await escrow.connect(operator).startGame(0);

      return { ...base };
    }

    it("Should end game and accrue fees", async function () {
      const { escrow, operator, buyIn } = await loadFixture(liveGameFixture);

      const gameBefore = await escrow.games(0);
      const accruedFeesBefore = await escrow.accruedFees();

      await expect(escrow.connect(operator).endGame(0))
        .to.emit(escrow, "GameEnded")
        .withArgs(0, gameBefore.reservedFee, await escrow.treasury());

      const game = await escrow.games(0);
      expect(game.status).to.equal(4); // ENDED
      expect(await escrow.accruedFees()).to.equal(accruedFeesBefore + gameBefore.reservedFee);
    });

    it("Should revert if game not live", async function () {
      const { escrow, operator, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await expect(escrow.connect(operator).endGame(0))
        .to.be.revertedWithCustomError(escrow, "GameNotLive");
    });

    it("Should revert if non-operator tries to end game", async function () {
      const { escrow, attacker } = await loadFixture(liveGameFixture);

      await expect(escrow.connect(attacker).endGame(0))
        .to.be.revertedWithCustomError(escrow, "NotOperator");
    });
  });

  describe("Fee Withdrawal", function () {
    async function gameWithFeesFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);
      await escrow.connect(base.playerC).joinGame(0);
      await escrow.connect(base.playerD).joinGame(0);

      await escrow.connect(operator).startGame(0);
      await escrow.connect(operator).endGame(0);

      return { ...base };
    }

    it("Should withdraw all fees when amount is 0", async function () {
      const { escrow, usdc, owner, treasury } = await loadFixture(gameWithFeesFixture);

      const accruedFees = await escrow.accruedFees();
      const treasuryBalanceBefore = await usdc.balanceOf(treasury.address);

      await expect(escrow.connect(owner).withdrawFees(0))
        .to.emit(escrow, "FeesWithdrawn")
        .withArgs(treasury.address, accruedFees);

      const treasuryBalanceAfter = await usdc.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(accruedFees);
      expect(await escrow.accruedFees()).to.equal(0);
    });

    it("Should withdraw specific amount", async function () {
      const { escrow, usdc, owner, treasury } = await loadFixture(gameWithFeesFixture);

      const accruedFees = await escrow.accruedFees();
      const withdrawAmount = accruedFees / 2n;
      const treasuryBalanceBefore = await usdc.balanceOf(treasury.address);

      await expect(escrow.connect(owner).withdrawFees(withdrawAmount))
        .to.emit(escrow, "FeesWithdrawn")
        .withArgs(treasury.address, withdrawAmount);

      const treasuryBalanceAfter = await usdc.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(withdrawAmount);
      expect(await escrow.accruedFees()).to.equal(accruedFees - withdrawAmount);
    });

    it("Should revert if insufficient fees", async function () {
      const { escrow, owner } = await loadFixture(gameWithFeesFixture);

      const accruedFees = await escrow.accruedFees();

      await expect(escrow.connect(owner).withdrawFees(accruedFees + 1n))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds");
    });

    it("Should revert if non-owner tries to withdraw", async function () {
      const { escrow, attacker } = await loadFixture(gameWithFeesFixture);

      await expect(escrow.connect(attacker).withdrawFees(0))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
  });

  describe("View Functions", function () {
    async function gameWithPlayersFixture() {
      const base = await loadFixture(deployContractsFixture);
      const { escrow, usdc, operator, buyIn } = base;

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      await usdc.connect(base.playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(base.playerB).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(base.playerA).joinGame(0);
      await escrow.connect(base.playerB).joinGame(0);

      return { ...base };
    }

    it("Should return correct game information", async function () {
      const { escrow, buyIn } = await loadFixture(gameWithPlayersFixture);

      const game = await escrow.getGame(0);
      expect(game.buyIn).to.equal(buyIn);
      expect(game.targetPlayers).to.equal(4);
      expect(game.status).to.equal(1); // WAITING
    });

    it("Should return correct player state", async function () {
      const { escrow, playerA, buyIn } = await loadFixture(gameWithPlayersFixture);

      const [deposited, active, everJoined, exited] = await escrow.getPlayerState(0, playerA.address);
      expect(deposited).to.equal(buyIn);
      expect(active).to.equal(true);
      expect(everJoined).to.equal(true);
      expect(exited).to.equal(false);
    });

    it("Should return available balance", async function () {
      const { escrow, operator, buyIn } = await loadFixture(gameWithPlayersFixture);

      await escrow.connect(operator).startGame(0);

      const game = await escrow.games(0);
      const expectedAvailable = game.totalDeposited - game.reservedFee - game.totalPaidOut;

      const available = await escrow.availableBalance(0);
      expect(available).to.equal(expectedAvailable);
    });

    it("Should return playerMaxValue as available balance", async function () {
      const { escrow, operator, playerA } = await loadFixture(gameWithPlayersFixture);

      await escrow.connect(operator).startGame(0);

      const available = await escrow.availableBalance(0);
      const maxValue = await escrow.playerMaxValue(0, playerA.address);

      expect(maxValue).to.equal(available);
    });
  });

  describe("Complete Game Flow", function () {
    it("Should handle complete game lifecycle", async function () {
      const { escrow, usdc, operator, playerA, playerB, playerC, playerD, treasury, owner, buyIn } =
        await loadFixture(deployContractsFixture);

      // 1. Create game
      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 4, deadline);

      // 2. Players join
      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerC).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerD).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(playerC).joinGame(0);
      await escrow.connect(playerD).joinGame(0);

      // 3. Start game
      await escrow.connect(operator).startGame(0);
      const game = await escrow.games(0);
      const totalDeposited = buyIn * 4n;
      expect(game.potAtStart).to.equal(totalDeposited);
      expect(game.reservedFee).to.equal((totalDeposited * 200n) / 10000n);

      // 4. Player A dies (50% payout)
      const valueA = buyIn;
      await escrow.connect(operator).settleDeathExit(0, playerA.address, valueA, 1);
      expect(await escrow.playerActive(0, playerA.address)).to.equal(false);
      expect(await escrow.activePlayerCount(0)).to.equal(3);

      // 5. Player B exits alive (100% payout, value higher than deposit)
      const valueB = buyIn * 2n; // Gained from A's death
      await escrow.connect(operator).settleAliveExit(0, playerB.address, valueB, 2);
      expect(await escrow.playerActive(0, playerB.address)).to.equal(false);
      expect(await escrow.activePlayerCount(0)).to.equal(2);

      // 6. Player A revives
      await escrow.connect(playerA).revive(0);
      expect(await escrow.playerActive(0, playerA.address)).to.equal(true);
      expect(await escrow.activePlayerCount(0)).to.equal(3);
      expect(await escrow.playerDeposited(0, playerA.address)).to.equal(buyIn * 2n);

      // 7. End game
      await escrow.connect(operator).endGame(0);
      expect((await escrow.games(0)).status).to.equal(4); // ENDED

      // 8. Withdraw fees
      const accruedFees = await escrow.accruedFees();
      const treasuryBalanceBefore = await usdc.balanceOf(treasury.address);
      await escrow.connect(owner).withdrawFees(0);
      const treasuryBalanceAfter = await usdc.balanceOf(treasury.address);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(accruedFees);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle multiple games simultaneously", async function () {
      const { escrow, usdc, operator, playerA, playerB, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);

      // Create 3 games
      for (let i = 0; i < 3; i++) {
        await escrow.connect(operator).createGame(buyIn, 2, deadline);
      }

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), buyIn * 10n);

      // Join all games
      for (let i = 0; i < 3; i++) {
        await escrow.connect(playerA).joinGame(i);
        await escrow.connect(playerB).joinGame(i);
        await escrow.connect(operator).startGame(i);
      }

      expect(await escrow.nextGameId()).to.equal(3);
      expect(await escrow.activePlayerCount(0)).to.equal(2);
      expect(await escrow.activePlayerCount(1)).to.equal(2);
      expect(await escrow.activePlayerCount(2)).to.equal(2);
    });

    it("Should handle player joining same game multiple times before start", async function () {
      const { escrow, usdc, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect((await ethers.getSigners())[1]).createGame(buyIn, 4, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);

      // Join first time
      await escrow.connect(playerA).joinGame(0);
      expect(await escrow.playerDeposited(0, playerA.address)).to.equal(buyIn);

      // Join again (should add to deposit)
      await escrow.connect(playerA).joinGame(0);
      expect(await escrow.playerDeposited(0, playerA.address)).to.equal(buyIn * 2n);
      expect(await escrow.activePlayerCount(0)).to.equal(1); // Still 1 active player
    });

    it("Should calculate available balance correctly after multiple settlements", async function () {
      const { escrow, usdc, operator, playerA, playerB, playerC, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 3, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerC).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(playerC).joinGame(0);

      await escrow.connect(operator).startGame(0);

      const game = await escrow.games(0);
      const initialAvailable = game.totalDeposited - game.reservedFee - game.totalPaidOut;

      // Player A dies
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);
      const availableAfterA = await escrow.availableBalance(0);
      expect(availableAfterA).to.be.lessThan(initialAvailable);

      // Player B exits alive
      await escrow.connect(operator).settleAliveExit(0, playerB.address, buyIn, 2);
      const availableAfterB = await escrow.availableBalance(0);
      expect(availableAfterB).to.be.lessThan(availableAfterA);
    });
  });

  describe("Security Tests", function () {
    it("Should prevent eventId replay attacks", async function () {
      const { escrow, usdc, operator, playerA, playerB, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 2, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(operator).startGame(0);

      const eventId = 12345;

      // First settlement succeeds
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, eventId);
      expect(await escrow.usedEventId(0, eventId)).to.equal(true);

      // Try to reuse same eventId - should fail
      await expect(escrow.connect(operator).settleDeathExit(0, playerB.address, buyIn, eventId))
        .to.be.revertedWithCustomError(escrow, "EventIdAlreadyUsed");
    });

    it("Should prevent settling same player twice", async function () {
      const { escrow, usdc, operator, playerA, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 2, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(operator).startGame(0);

      // First settlement
      await escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 1);

      // Try to settle again - should fail
      await expect(escrow.connect(operator).settleDeathExit(0, playerA.address, buyIn, 2))
        .to.be.revertedWithCustomError(escrow, "PlayerNotActive");
    });

    it("Should enforce available funds check", async function () {
      const { escrow, usdc, operator, playerA, playerB, buyIn } = await loadFixture(deployContractsFixture);

      const deadline = await getFutureTimestamp(3600);
      await escrow.connect(operator).createGame(buyIn, 2, deadline);

      await usdc.connect(playerA).approve(await escrow.getAddress(), buyIn * 10n);
      await usdc.connect(playerB).approve(await escrow.getAddress(), buyIn * 10n);

      await escrow.connect(playerA).joinGame(0);
      await escrow.connect(playerB).joinGame(0);
      await escrow.connect(operator).startGame(0);

      const game = await escrow.games(0);
      const available = game.totalDeposited - game.reservedFee - game.totalPaidOut;

      // Try to settle with value that would exceed available funds
      const excessiveValue = available * 2n;

      await expect(escrow.connect(operator).settleAliveExit(0, playerA.address, excessiveValue, 1))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds");
    });
  });
});

