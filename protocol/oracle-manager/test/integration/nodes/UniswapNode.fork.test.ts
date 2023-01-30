import { ethers } from 'ethers';

import { bootstrap } from '../bootstrap';
import NodeTypes from '../mixins/Node.types';

describe.skip('UniswapNodeFork', function () {
  const { getContract } = bootstrap();

  const abi = ethers.utils.defaultAbiCoder;
  let NodeModule: ethers.Contract;
  let nodeId: string;

  const poolAddress = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
  //18 WETH
  const token0 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  //6 USDC
  const token1 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  let pool: ethers.Contract;

  before('prepare environment', async () => {
    NodeModule = getContract('NodeModule');
    pool = await hre.ethers.getContractAt('IUniswapV3Pool', poolAddress);
  });

  it('register the uniswap node the latest price', async () => {
    const NodeParameters = abi.encode(
      ['address', 'address', 'uint8', 'uint8', 'address', 'uint32'],
      [token0, token1, 18, 6, pool.address, 2]
    );
    await NodeModule.registerNode(NodeTypes.UNISWAP, NodeParameters, []);
    nodeId = await NodeModule.getNodeId(NodeTypes.UNISWAP, NodeParameters, []);
  });

  it('retrieves the latest price', async () => {
    const output = await NodeModule.process(nodeId);
    console.log('price:', output.price.toString());
  });
});
