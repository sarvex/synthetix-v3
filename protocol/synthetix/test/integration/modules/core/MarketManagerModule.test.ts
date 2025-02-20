import assert from 'assert/strict';
import assertBn from '@synthetixio/core-utils/utils/assertions/assert-bignumber';
import assertRevert from '@synthetixio/core-utils/utils/assertions/assert-revert';
import assertEvent from '@synthetixio/core-utils/utils/assertions/assert-event';
import { ethers } from 'ethers';

import { bootstrapWithMockMarketAndPool } from '../../bootstrap';
import { MockMarket__factory } from '../../../../typechain-types/index';
import { verifyUsesFeatureFlag } from '../../verifications';
import { snapshotCheckpoint } from '@synthetixio/core-utils/utils/mocha/snapshot';

describe('MarketManagerModule', function () {
  const {
    signers,
    systems,
    provider,
    collateralAddress,
    poolId,
    accountId,
    MockMarket,
    marketId,
    depositAmount,
    restore,
  } = bootstrapWithMockMarketAndPool();

  const One = ethers.utils.parseEther('1');
  const Hundred = ethers.utils.parseEther('100');

  const feeAddress = '0x1234567890123456789012345678901234567890';

  let owner: ethers.Signer, user1: ethers.Signer, user2: ethers.Signer;

  let txn: Parameters<typeof assertEvent>[0];

  before('identify signers', async () => {
    [owner, user1, user2] = signers();
  });

  describe('registerMarket()', async () => {
    before(restore);

    verifyUsesFeatureFlag(
      () => systems().Core,
      'registerMarket',
      () => systems().Core.connect(user2).registerMarket(user1.getAddress())
    );

    it('reverts when trying to register a market that does not support the IMarket interface', async function () {
      await assertRevert(
        systems()
          .Core.connect(owner)
          .registerMarket(await owner.getAddress()),
        `IncorrectMarketInterface("${await owner.getAddress()}")`
      );
    });

    describe('successful', async () => {
      let expectedMarketId: ethers.BigNumber;
      let deployedMarket: ethers.Contract;

      before('register', async () => {
        expectedMarketId = marketId().add(1);

        // deploy the mock market (it will register itself)
        deployedMarket = await new MockMarket__factory(user1).deploy();
        await deployedMarket.deployed();

        txn = await (await systems().Core.registerMarket(deployedMarket.address)).wait();
      });

      it('emits correct event', async () => {
        await assertEvent(
          txn,
          `MarketRegistered("${deployedMarket.address}", ${expectedMarketId}`,
          systems().Core
        );
      });

      it('liquidity is zero', async () => {
        assertBn.isZero(await systems().Core.getMarketCollateral(expectedMarketId));
      });

      it('totalDebt is zero', async () => {
        assertBn.isZero(await systems().Core.getMarketTotalDebt(expectedMarketId));
      });
    });
  });

  describe('depositMarketUsd()', async () => {
    before(restore);

    before('acquire USD', async () => {
      await systems().Core.connect(user1).mintUsd(accountId, 0, collateralAddress(), One);
    });

    it('should not work if user has not approved', async () => {
      await assertRevert(
        MockMarket().connect(user1).buySynth(One),
        `InsufficientAllowance("${One.toString()}", "0")`,
        systems().Core
      );
    });

    describe('when funds have been approved', async () => {
      before('approve usd', async () => {
        await systems().USD.connect(user1).approve(MockMarket().address, One);
      });

      const restoreDeposit = snapshotCheckpoint(provider);

      verifyUsesFeatureFlag(
        () => systems().Core,
        'depositMarketUsd',
        () => MockMarket().connect(user1).buySynth(One)
      );

      describe('success', async () => {
        before(restoreDeposit);
        before('deposit', async () => {
          txn = await MockMarket().connect(user1).buySynth(One);
        });

        it('takes USD away', async () => {
          assertBn.isZero(await systems().USD.balanceOf(await user1.getAddress()));
        });

        it('increases withdrawableUsd', async () => {
          assertBn.equal(
            await systems().Core.connect(user1).getWithdrawableMarketUsd(marketId()),
            depositAmount.add(One)
          );
        });

        it('leaves totalDebt the same', async () => {
          assertBn.isZero(await systems().Core.connect(user1).getMarketTotalDebt(marketId()));
        });

        it('accrues no debt', async () => {
          // should only have the one USD minted earlier
          assertBn.equal(
            await systems().Core.callStatic.getVaultDebt(poolId, collateralAddress()),
            0
          );
        });
      });

      describe('when fee is levied', async () => {
        before(restoreDeposit);
        before('set fee', async () => {
          await systems()
            .Core.connect(owner)
            .setConfig(
              ethers.utils.formatBytes32String('depositMarketUsd_feeRatio'),
              ethers.utils.hexZeroPad(ethers.utils.parseEther('0.01').toHexString(), 32)
            ); // 1% fee levy
          await systems()
            .Core.connect(owner)
            .setConfig(
              ethers.utils.formatBytes32String('depositMarketUsd_feeAddress'),
              ethers.utils.hexZeroPad(feeAddress, 32)
            );
        });

        let quotedFee;
        let returnValue;

        before('deposit', async () => {
          quotedFee = (await systems().Core.getMarketFees(marketId(), One))[0];
          returnValue = await MockMarket().connect(user1).callStatic.buySynth(One);
          txn = await MockMarket().connect(user1).buySynth(One);
        });

        it('takes USD away', async () => {
          assertBn.isZero(await systems().USD.balanceOf(await user1.getAddress()));
        });

        it('sent USD to fee address', async () => {
          assertBn.equal(await systems().USD.balanceOf(feeAddress), One.div(100));
        });

        it('increases withdrawableUsd (minus a fee)', async () => {
          assertBn.equal(
            await systems().Core.connect(user1).getWithdrawableMarketUsd(marketId()),
            depositAmount.add(One).sub(One.div(100))
          );
        });

        it('increases total debt by the fee', async () => {
          assertBn.equal(
            await systems().Core.connect(user1).getMarketTotalDebt(marketId()),
            One.div(100)
          );
        });

        it('accrues debt for the fee', async () => {
          // should only have the one USD minted earlier
          assertBn.equal(
            await systems().Core.callStatic.getVaultDebt(poolId, collateralAddress()),
            One.div(100)
          );
        });

        it('returned fees paid', async () => {
          assertBn.gt(returnValue, 0);
          assertBn.equal(quotedFee, returnValue);
        });
      });
    });
  });

  describe('withdrawMarketUsd()', async () => {
    before(restore);

    describe('deposit into the pool', async () => {
      before('mint USD to use market', async () => {
        await systems().Core.connect(user1).mintUsd(accountId, 0, collateralAddress(), One);
        await systems().USD.connect(user1).approve(MockMarket().address, One);
        txn = await MockMarket().connect(user1).buySynth(One);
      });

      const withdrawRestore = snapshotCheckpoint(provider);

      it('reverts if not enough liquidity', async () => {
        const reportedDebtBefore = await MockMarket().connect(user1).reportedDebt(0);
        await MockMarket().connect(user1).setReportedDebt(Hundred.mul(100000));

        await assertRevert(
          MockMarket().connect(user1).sellSynth(Hundred.mul(100000)),
          `NotEnoughLiquidity("${marketId()}", "${Hundred.mul(100000).toString()}")`,
          systems().Core
        );

        await MockMarket().connect(user1).setReportedDebt(reportedDebtBefore);
      });

      verifyUsesFeatureFlag(
        () => systems().Core,
        'withdrawMarketUsd',
        () => MockMarket().connect(user1).sellSynth(One.div(2))
      );

      describe('withdraw some from the market', async () => {
        before(withdrawRestore);
        before('mint USD to use market', async () => {
          txn = await (await MockMarket().connect(user1).sellSynth(One.div(2))).wait();
        });

        it('decreased withdrawable usd', async () => {
          const liquidity = await systems().Core.getWithdrawableMarketUsd(marketId());
          assertBn.equal(liquidity, depositAmount.add(One.div(2)));
        });

        it('leaves totalDebt the same', async () => {
          assertBn.isZero(await systems().Core.connect(user1).getMarketTotalDebt(marketId()));
        });

        it('makes USD', async () => {
          assertBn.equal(await systems().USD.balanceOf(await user1.getAddress()), One.div(2));
        });

        describe('withdraw the rest', async () => {
          before('mint USD to use market', async () => {
            txn = await MockMarket().connect(user1).sellSynth(One.div(2));
          });

          it('decreased withdrawable usd', async () => {
            const liquidity = await systems().Core.getWithdrawableMarketUsd(marketId());
            assertBn.equal(liquidity, depositAmount);
          });

          it('leaves totalDebt the same', async () => {
            assertBn.isZero(await systems().Core.connect(user1).getMarketTotalDebt(marketId()));
          });

          it('makes USD', async () => {
            assertBn.equal(await systems().USD.balanceOf(await user1.getAddress()), One);
          });
        });
      });

      describe('when fee is levied', async () => {
        before(withdrawRestore);
        before('set fee', async () => {
          await systems()
            .Core.connect(owner)
            .setConfig(
              ethers.utils.formatBytes32String('withdrawMarketUsd_feeRatio'),
              ethers.utils.hexZeroPad(ethers.utils.parseEther('0.01').toHexString(), 32)
            ); // 1% fee levy
          await systems()
            .Core.connect(owner)
            .setConfig(
              ethers.utils.formatBytes32String('withdrawMarketUsd_feeAddress'),
              ethers.utils.hexZeroPad(feeAddress, 32)
            );
        });

        let quotedFee;
        let returnValue;

        before('mint USD to use market', async () => {
          quotedFee = (await systems().Core.getMarketFees(marketId(), One.div(2)))[1];
          returnValue = await MockMarket().connect(user1).callStatic.sellSynth(One.div(2));
          txn = await (await MockMarket().connect(user1).sellSynth(One.div(2))).wait();
        });

        it('decreased withdrawable usd', async () => {
          const liquidity = await systems().Core.getWithdrawableMarketUsd(marketId());
          // also subtract the fee here
          assertBn.equal(liquidity, depositAmount.add(One.div(2)).sub(One.div(200)));
        });

        it('leaves totalDebt the same', async () => {
          assertBn.equal(
            await systems().Core.connect(user1).getMarketTotalDebt(marketId()),
            One.div(200)
          );
        });

        it('makes USD', async () => {
          assertBn.equal(await systems().USD.balanceOf(await user1.getAddress()), One.div(2));
        });

        it('sent USD to fee address', async () => {
          assertBn.equal(await systems().USD.balanceOf(feeAddress), One.div(200));
        });

        it('returned fees paid', async () => {
          assertBn.gt(returnValue, 0);
          assertBn.equal(quotedFee, returnValue);
        });
      });
    });
  });

  describe('distributeDebtToPools()', async () => {
    before(restore);
    before('add more staked pools', async () => {
      // want a total of 3 staked pools
      // create
      await systems()
        .Core.connect(owner)
        .createPool(poolId + 1, await owner.getAddress());
      await systems()
        .Core.connect(owner)
        .createPool(poolId + 2, await owner.getAddress());

      // configure
      await systems()
        .Core.connect(owner)
        .setPoolConfiguration(poolId, [
          {
            marketId: marketId(),
            weightD18: ethers.utils.parseEther('1'),
            maxDebtShareValueD18: ethers.utils.parseEther('0.1'),
          },
        ]);
      await systems()
        .Core.connect(owner)
        .setPoolConfiguration(poolId + 1, [
          {
            marketId: marketId(),
            weightD18: ethers.utils.parseEther('1'),
            maxDebtShareValueD18: ethers.utils.parseEther('0.2'),
          },
        ]);
      await systems()
        .Core.connect(owner)
        .setPoolConfiguration(poolId + 2, [
          {
            marketId: marketId(),
            weightD18: ethers.utils.parseEther('1'),
            maxDebtShareValueD18: ethers.utils.parseEther('0.3'),
          },
        ]);

      // delegate
      await systems()
        .Core.connect(user1)
        .delegateCollateral(
          accountId,
          poolId + 1,
          collateralAddress(),
          depositAmount,
          ethers.utils.parseEther('1')
        );

      await systems()
        .Core.connect(user1)
        .delegateCollateral(
          accountId,
          poolId + 2,
          collateralAddress(),
          depositAmount,
          ethers.utils.parseEther('1')
        );
    });

    before('accumulate debt', async () => {
      await MockMarket().setReportedDebt(ethers.utils.parseEther('12341234123412341234'));
    });

    it('calling distribute debt to pools says its incomplete', async () => {
      assert.equal(await systems().Core.callStatic.distributeDebtToPools(marketId(), '1'), false);
    });

    describe('call first time', async () => {
      before('first time called', async () => {
        await systems().Core.distributeDebtToPools(marketId(), 2);
      });

      it('has not fully restored the debt', async () => {
        assertBn.equal(
          await systems().Core.callStatic.Market_getDebtPerShare(marketId()),
          ethers.utils.parseEther('0.2')
        );
      });

      it('calling distribute debt to pools says its now complete', async () => {
        assert.equal(await systems().Core.callStatic.distributeDebtToPools(marketId(), '2'), true);
      });

      describe('call second time', async () => {
        before('second time called', async () => {
          await systems().Core.distributeDebtToPools(marketId(), 2);
        });

        it('has fully restored the debt', async () => {
          // last pool has a limit of 3 ether
          assertBn.equal(
            await systems().Core.callStatic.Market_getDebtPerShare(marketId()),
            ethers.utils.parseEther('0.3')
          );
        });
      });
    });
  });

  describe('setMarketMinDelegateTime()', () => {
    before(restore);

    it('only works for market', async () => {
      await assertRevert(
        systems().Core.setMarketMinDelegateTime(marketId(), 86400),
        'Unauthorized',
        systems().Core
      );
    });

    it('fails when min delegation time is unreasonably large', async () => {
      await assertRevert(
        MockMarket().setMinDelegationTime(100000000),
        'InvalidParameter("minDelegateTime"',
        systems().Core
      );
    });

    describe('success', () => {
      let tx: ethers.providers.TransactionResponse;
      before('exec', async () => {
        tx = await MockMarket().setMinDelegationTime(86400);
      });

      it('sets the value', async () => {
        assertBn.equal(await systems().Core.getMarketMinDelegateTime(marketId()), 86400);
      });

      it('emits', async () => {
        await assertEvent(tx, `SetMinDelegateTime(${marketId()}, 86400)`, systems().Core);
      });
    });
  });

  describe('getUsdToken()', () => {
    it('returns the USD token', async () => {
      assert.equal(await systems().Core.getUsdToken(), systems().USD.address);
    });
  });
});
