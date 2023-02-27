import { ethers as Ethers } from 'ethers';
import { bn, bootstrapTraders, bootstrapWithSynth } from './bootstrap';
import assertRevert from '@synthetixio/core-utils/utils/assertions/assert-revert';
import { SynthRouter } from '../generated/typechain';
import { snapshotCheckpoint } from '@synthetixio/main/test/utils/snapshot';
import assertBn from '@synthetixio/core-utils/utils/assertions/assert-bignumber';
import assertEvent from '@synthetixio/core-utils/utils/assertions/assert-event';

describe.only('Afif integration test', () => {
  const { systems, signers, marketId, provider } = bootstrapTraders(
    bootstrapWithSynth('Synthetic Ether', 'snxETH')
  );

  let marketOwner: Ethers.Signer, trader1: Ethers.Signer, trader2: Ethers.Signer;
  let synth: SynthRouter;

  before('identify actors', async () => {
    [, , marketOwner, trader1, trader2] = signers();
  });

  before('identify synth', async () => {
    const synthAddress = await systems().SpotMarket.getSynth(1);
    synth = systems().Synth(synthAddress);
  });

  before('set skew scale to 100 snxETH', async () => {
    await systems().SpotMarket.connect(marketOwner).setMarketSkewScale(marketId(), bn(100));
  });

  before('set wrapper', async () => {
    await systems()
      .SpotMarket.connect(marketOwner)
      .setWrapper(marketId(), systems().CollateralMock.address, bn(500));
  });

  const restore = snapshotCheckpoint(provider);

  describe('buy and sell', () => {
    before('buy', async () => {
      // $1000/eth
      await systems().USD.connect(trader1).approve(systems().SpotMarket.address, bn(10_000));
      await systems().SpotMarket.connect(trader1).buy(marketId(), bn(10_000), bn(0));
    });

    before('enable wrapper', async () => {
      await systems()
        .SpotMarket.connect(marketOwner)
        .setWrapper(marketId(), systems().CollateralMock.address, bn(500));
    });

    it('check synth balance of trader 1', async () => {
      console.log(await synth.balanceOf(await trader1.getAddress()));
    });

    describe('sell', () => {
      before('sell', async () => {
        console.log(
          'BEFORE USD AMOUNT FOR TRADER',
          await systems().USD.balanceOf(await trader1.getAddress())
        );
        await synth.connect(trader1).approve(systems().SpotMarket.address, bn(9.5));
        await systems().SpotMarket.connect(trader1).sell(marketId(), bn(9.5), bn(0));
      });

      it('check usd balance of trader 1', async () => {
        console.log(
          'AFTER USD AMOUNT FOR TRADER',
          await systems().USD.balanceOf(await trader1.getAddress())
        );
      });
    });
  });

  describe('wrap and sell', () => {
    before(restore);

    before('wrap', async () => {
      await systems().CollateralMock.connect(trader1).approve(systems().SpotMarket.address, bn(10));

      await systems().SpotMarket.connect(trader1).wrap(marketId(), bn(10), 0);
    });

    it('has 10 eth balance', async () => {
      console.log('BALANCE', await synth.balanceOf(await trader1.getAddress()));
    });

    describe('sell', () => {
      before('sell', async () => {
        console.log(
          'BEFORE USD AMOUNT FOR TRADER',
          await systems().USD.balanceOf(await trader1.getAddress())
        );
        await synth.connect(trader1).approve(systems().SpotMarket.address, bn(10));
        await systems().SpotMarket.connect(trader1).sell(marketId(), bn(10), bn(0));
      });

      it('check usd balance of trader 1', async () => {
        console.log(
          'AFTER USD AMOUNT FOR TRADER',
          await systems().USD.balanceOf(await trader1.getAddress())
        );
      });
    });

    describe('buy', () => {
      before('buy $9500', async () => {
        // $1000/eth
        await systems().USD.connect(trader1).approve(systems().SpotMarket.address, bn(9_500));
        await systems().SpotMarket.connect(trader1).buy(marketId(), bn(9_500), bn(0));
      });

      it('check synth balance of trader 1', async () => {
        console.log(await synth.balanceOf(await trader1.getAddress()));
      });
    });
  });

  describe('buy two $5000, sell all', () => {
    before(restore);

    before('buy multiple $5000', async () => {
      await systems().USD.connect(trader1).approve(systems().SpotMarket.address, bn(5_000));
      await systems().SpotMarket.connect(trader1).buy(marketId(), bn(5_000), bn(0));

      await systems().USD.connect(trader1).approve(systems().SpotMarket.address, bn(5_000));
      await systems().SpotMarket.connect(trader1).buy(marketId(), bn(5_000), bn(0));
    });
    let beforeSellUsd: Ethers.BigNumber;

    before('sell all', async () => {
      beforeSellUsd = await systems().USD.balanceOf(await trader1.getAddress());
      console.log("TRADER'S USD BALANCE BEFORE", beforeSellUsd);
      const synthTraderValue = await synth.balanceOf(await trader1.getAddress());
      console.log(synthTraderValue);

      await synth.connect(trader1).approve(systems().SpotMarket.address, synthTraderValue);
      await systems().SpotMarket.connect(trader1).sell(marketId(), synthTraderValue, bn(0));
    });

    it('check synth balance of trader 1', async () => {
      const afterTraderUsd = await systems().USD.balanceOf(await trader1.getAddress());
      console.log("TRADER'S USD BALANCE AFTER", afterTraderUsd);
      console.log(afterTraderUsd.sub(beforeSellUsd).toString());
    });
  });

  describe.only('buy $10,000, sell half and half', () => {
    before(restore);

    before('buy multiple $5000', async () => {
      await systems().USD.connect(trader1).approve(systems().SpotMarket.address, bn(10_000));
      await systems().SpotMarket.connect(trader1).buy(marketId(), bn(10_000), bn(0));
    });
    let firstBeforeSellUsd: Ethers.BigNumber;

    before('sell all', async () => {
      firstBeforeSellUsd = await systems().USD.balanceOf(await trader1.getAddress());
      console.log("TRADER'S USD BALANCE BEFORE", firstBeforeSellUsd);
      const synthTraderValue = await synth.balanceOf(await trader1.getAddress());
      console.log(synthTraderValue);

      await synth.connect(trader1).approve(systems().SpotMarket.address, synthTraderValue.div(2));
      await systems().SpotMarket.connect(trader1).sell(marketId(), synthTraderValue.div(2), bn(0));

      const afterFirstSell = await systems().USD.balanceOf(await trader1.getAddress());
      console.log("TRADER'S USD BALANCE AFTER 1st TRADE", afterFirstSell);
      console.log(
        'CHANGE IN BALANCE AFTER FIRST TRADE',
        afterFirstSell.sub(firstBeforeSellUsd).toString()
      );

      await synth.connect(trader1).approve(systems().SpotMarket.address, synthTraderValue.div(2));
      await systems().SpotMarket.connect(trader1).sell(marketId(), synthTraderValue.div(2), bn(0));
    });

    it('check synth balance of trader 1', async () => {
      const afterSecondSell = await systems().USD.balanceOf(await trader1.getAddress());
      console.log(
        'CHANGE IN BALANCE AFTER SECOND TRADE',
        afterSecondSell.sub(firstBeforeSellUsd).toString()
      );
    });
  });
});
