import { findSingleEvent } from '@synthetixio/core-utils/utils/ethers/events';
import { snapshotCheckpoint } from '@synthetixio/core-utils/utils/mocha/snapshot';
import NodeTypes from '@synthetixio/oracle-manager/test/integration/mixins/Node.types';
import { coreBootstrap } from '@synthetixio/router/utils/tests';
import { wei } from '@synthetixio/wei';
import { BigNumber, ethers } from 'ethers';
import hre from 'hardhat';
import { SpotMarketProxy, SynthRouter } from './generated/typechain';
import { AggregatorV3Mock, FeeCollectorMock, OracleVerifierMock } from '../typechain-types/index';
import {
  USDProxy,
  CollateralMock,
  USDRouter,
  CoreProxy,
} from '@synthetixio/main/test/generated/typechain';
import { OracleManagerModule } from '@synthetixio/oracle-manager/test/generated/typechain';

type Proxies = {
  ['synthetix.CoreProxy']: CoreProxy;
  ['synthetix.USDProxy']: USDProxy;
  ['synthetix.CollateralMock']: CollateralMock;
  ['synthetix.oracle_manager.Proxy']: OracleManagerModule;
  SpotMarketProxy: SpotMarketProxy;
  SynthRouter: SynthRouter;
  FeeCollectorMock: FeeCollectorMock;
  OracleVerifierMock: OracleVerifierMock;
  ['synthetix.USDRouter']: USDRouter;
};

export type Systems = {
  SpotMarket: SpotMarketProxy;
  Core: CoreProxy;
  USD: USDProxy;
  USDRouter: USDRouter;
  CollateralMock: CollateralMock;
  OracleManager: OracleManagerModule;
  OracleVerifierMock: OracleVerifierMock;
  FeeCollectorMock: FeeCollectorMock;
  Synth: (address: string) => SynthRouter;
};

const params = { cannonfile: 'cannonfile.test.toml' };

// TODO: find an alternative way for custom config on fork tests. Probably having
//       another bootstrap.ts on the test-fork/ folder would be best.
// hre.network.name === 'cannon'
//   ? { cannonfile: 'cannonfile.test.toml' }
//   : {
//       dryRun: true,
//       impersonate: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
//       cannonfile: 'cannonfile.test.toml',
//     };

const { getProvider, getSigners, getContract, createSnapshot } = coreBootstrap<Proxies>(params);

const restoreSnapshot = createSnapshot();

let contracts: Systems;
before('load contracts', () => {
  contracts = {
    Core: getContract('synthetix.CoreProxy'),
    USD: getContract('synthetix.USDProxy'),
    USDRouter: getContract('synthetix.USDRouter'),
    SpotMarket: getContract('SpotMarketProxy'),
    OracleManager: getContract('synthetix.oracle_manager.Proxy'),
    CollateralMock: getContract('synthetix.CollateralMock'),
    FeeCollectorMock: getContract('FeeCollectorMock'),
    OracleVerifierMock: getContract('OracleVerifierMock'),
    Synth: (address: string) => getContract('SynthRouter', address),
  };
});

export function bootstrap() {
  before(restoreSnapshot);
  const signers: ethers.Wallet[] = [];

  before('set up accounts', async () => {
    const provider = getProvider();
    for (let i = getSigners().length; i < 8; i++) {
      const signer = ethers.Wallet.fromMnemonic(
        'test test test test test test test test test test test junk',
        `m/44'/60'/0'/0/${i}`
      ).connect(provider);
      signers.push(signer);
      await provider.send('hardhat_setBalance', [
        await signer.getAddress(),
        `0x${(1e22).toString(16)}`,
      ]);
    }
  });

  before('give owner permission to create pools', async () => {
    const [owner] = getSigners();
    await contracts.Core.addToFeatureFlagAllowlist(
      ethers.utils.formatBytes32String('createPool'),
      await owner.getAddress()
    );
  });

  return {
    provider: () => getProvider(),
    signers: () => [...getSigners(), ...signers],
    owner: () => getSigners()[0],
    systems: () => contracts,
  };
}

const depositAmount = ethers.utils.parseEther('1000');
/*
  same as protocol/synthetix/test/integration/bootstrap.ts#L70
  because of the way the contracts are loaded, seems like reusability is outside the scope
*/
export function bootstrapWithStakedPool() {
  const r = bootstrap();

  let aggregator: ethers.Contract;

  let oracleNodeId: string;
  const accountId = 1;
  const poolId = 1;
  let collateralAddress: string;
  const depositAmount = ethers.utils.parseEther('1000');

  before('setup oracle manager node', async () => {
    const results = await createOracleNode(
      r.signers()[0],
      ethers.utils.parseEther('1000'),
      r.systems().OracleManager
    );

    oracleNodeId = results.oracleNodeId;
    aggregator = results.aggregator;
  });

  before('configure collateral', async () => {
    const [owner] = r.signers();

    // add collateral
    await (
      await r.systems().Core.connect(owner).configureCollateral({
        tokenAddress: r.systems().CollateralMock.address,
        oracleNodeId,
        issuanceRatioD18: '5000000000000000000',
        liquidationRatioD18: '1500000000000000000',
        liquidationRewardD18: '20000000000000000000',
        minDelegationD18: '20000000000000000000',
        depositingEnabled: true,
      })
    ).wait();
  });

  before('create pool', async () => {
    const [owner] = r.signers();
    // create pool
    await r
      .systems()
      .Core.connect(owner)
      .createPool(poolId, await owner.getAddress());
  });

  before('stake', async function () {
    const [, staker] = r.signers();
    await stake(r.systems, poolId, accountId, staker, depositAmount.div(10));
  });

  const restore = snapshotCheckpoint(r.provider);

  const generateExternalNode = async (price: number) => {
    const factory = await hre.ethers.getContractFactory('MockExternalNode');
    const externalNode = await factory.deploy(price, 200); // used to have .connect(owner)

    // Register the mock
    const NodeParameters = ethers.utils.defaultAbiCoder.encode(['address'], [externalNode.address]);
    const tx = await r.systems().OracleManager.registerNode(NodeTypes.EXTERNAL, NodeParameters, []);
    const receipt = await tx.wait();
    const event = findSingleEvent({
      receipt,
      eventName: 'NodeRegistered',
    });
    return event.args.nodeId;
  };

  return {
    ...r,
    aggregator: () => aggregator,
    accountId,
    poolId,
    collateralContract: () => r.systems().CollateralMock,
    collateralAddress: () => collateralAddress,
    depositAmount,
    restore,
    oracleNodeId: () => oracleNodeId,
    generateExternalNode,
  };
}

export function bootstrapWithSynth(name: string, token: string) {
  const r = bootstrapWithStakedPool();
  let coreOwner: ethers.Signer, marketOwner: ethers.Signer;
  let marketId: BigNumber;
  let aggregator: AggregatorV3Mock;

  before('identify market owner', async () => {
    [coreOwner, , marketOwner] = r.signers();
  });

  before('register synth', async () => {
    marketId = await r
      .systems()
      .SpotMarket.callStatic.createSynth(name, token, await marketOwner.getAddress());
    await r.systems().SpotMarket.createSynth(name, token, await marketOwner.getAddress());
  });

  before('configure market collateral supply cap', async () => {
    await r
      .systems()
      .Core.connect(coreOwner)
      .configureMaximumMarketCollateral(
        marketId,
        r.systems().CollateralMock.address,
        ethers.constants.MaxUint256
      );
  });

  before('setup buy and sell feeds', async () => {
    const result = await createOracleNode(
      r.signers()[0],
      ethers.utils.parseEther('900'),
      r.systems().OracleManager
    );
    aggregator = result.aggregator;
    await r
      .systems()
      .SpotMarket.connect(marketOwner)
      .updatePriceData(marketId, r.oracleNodeId(), result.oracleNodeId);
  });

  // add weight to market from pool

  before('delegate pool collateral to market', async () => {
    await r
      .systems()
      .Core.connect(coreOwner)
      .setPoolConfiguration(r.poolId, [
        {
          marketId,
          weightD18: ethers.utils.parseEther('1'),
          maxDebtShareValueD18: ethers.utils.parseEther('1'),
        },
      ]);
  });

  const restore = snapshotCheckpoint(r.provider);

  return {
    ...r,
    marketId: () => marketId,
    marketOwner: () => marketOwner,
    aggregator: () => aggregator,
    restore,
  };
}

/*
  1. creates a new pool
  2. mints collateral for new users
  3. delegates collateral to pool
  4. mint max USD
  5. traders now have USD to trade with
*/
export function bootstrapTraders(r: ReturnType<typeof bootstrapWithSynth>) {
  const { signers, systems, provider } = r;

  // separate pool so doesn't mess with existing pool accounting
  before('create separate pool', async () => {
    const [owner] = signers();
    await systems()
      .Core.connect(owner)
      .createPool(2, await owner.getAddress());
  });

  before('create traders', async () => {
    const [, , , trader1, trader2] = signers();
    await stake(systems, 2, 1000, trader1);
    await stake(systems, 2, 1001, trader2);
  });

  before('mint usd', async () => {
    const [, , , trader1, trader2] = signers();
    const collateralAddress = systems().CollateralMock.address;
    await systems()
      .Core.connect(trader1)
      .mintUsd(1000, 2, collateralAddress, depositAmount.mul(200));
    await systems()
      .Core.connect(trader2)
      .mintUsd(1001, 2, collateralAddress, depositAmount.mul(200));
  });

  const restore = snapshotCheckpoint(provider);

  return {
    ...r,
    restore,
  };
}

const stake = async (
  systems: () => Systems,
  poolId: number,
  accountId: number,
  user: ethers.Signer,
  delegateAmount: ethers.BigNumber = depositAmount
) => {
  await systems().CollateralMock.mint(await user.getAddress(), depositAmount.mul(1000));

  // create user account
  await systems().Core.connect(user).createAccount(accountId);

  // approve
  await systems()
    .CollateralMock.connect(user)
    .approve(systems().Core.address, depositAmount.mul(10));

  // stake collateral
  await systems()
    .Core.connect(user)
    .deposit(accountId, systems().CollateralMock.address, depositAmount.mul(10));

  // invest in the pool
  await systems()
    .Core.connect(user)
    .delegateCollateral(
      accountId,
      poolId,
      systems().CollateralMock.address,
      delegateAmount,
      ethers.utils.parseEther('1')
    );
};

const createOracleNode = async (
  owner: ethers.Signer,
  price: ethers.BigNumber,
  OracleManager: synthetix.oracleManager.Proxy
) => {
  const abi = ethers.utils.defaultAbiCoder;
  const factory = await hre.ethers.getContractFactory('AggregatorV3Mock');
  const aggregator = await factory.connect(owner).deploy();

  await aggregator.mockSetCurrentPrice(price);

  const params1 = abi.encode(['address', 'uint256', 'uint8'], [aggregator.address, 0, 18]);
  await OracleManager.connect(owner).registerNode(NodeTypes.CHAINLINK, params1, []);
  const oracleNodeId = await OracleManager.connect(owner).getNodeId(
    NodeTypes.CHAINLINK,
    params1,
    []
  );

  return {
    oracleNodeId,
    aggregator,
  };
};

export const bn = (n: number) => wei(n).toBN();
