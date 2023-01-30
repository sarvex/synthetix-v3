import assertBn from '@synthetixio/core-utils/utils/assertions/assert-bignumber';
import { ethers } from 'ethers';

import { bootstrap } from '../bootstrap';
import NodeTypes from '../mixins/Node.types';

const parseUnits = ethers.utils.parseUnits;

describe.skip('PythNode Fork', function () {
  const { getContract, getSigners } = bootstrap();

  const abi = ethers.utils.defaultAbiCoder;
  let NodeModule: ethers.Contract;
  let Pyth: ethers.Contract;

  const pythAddress = '0x4305FB66699C3B2702D4d05CF36551390A4c69C6';
  const priceFeedId = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

  before('prepare environment', async () => {
    NodeModule = getContract('NodeModule');
    Pyth = await hre.ethers.getContractAt('IPyth', pythAddress);
  });

  it('retrieves the latest price', async () => {
    // Register the mock
    const NodeParameters = abi.encode(
      ['address', 'bytes32', 'bool'],
      [Pyth.address, priceFeedId, false]
    );
    await NodeModule.registerNode(NodeTypes.PYTH, NodeParameters, []);
    const nodeId = await NodeModule.getNodeId(NodeTypes.PYTH, NodeParameters, []);

    // Verify the node processes output as expected
    const output = await NodeModule.process(nodeId);
    console.log(output.timestamp.toString());
    console.log(output.price.toString());
    // assertBn.equal(output.price, parseUnits(price, 18 - decimals).toString());
    // assertBn.equal(output.timestamp, timestamp);
  });

  it('retrieves the ema price', async () => {
    // Register the mock
    const NodeParameters = abi.encode(
      ['address', 'bytes32', 'bool'],
      [PythMock.address, priceFeedId, true]
    );
    await NodeModule.registerNode(NodeTypes.PYTH, NodeParameters, []);
    const nodeId = await NodeModule.getNodeId(NodeTypes.PYTH, NodeParameters, []);

    // Verify the node processes output as expected
    const output = await NodeModule.process(nodeId);
    assertBn.equal(output.price, parseUnits(emaPrice, 18 - decimals).toString());
    assertBn.equal(output.timestamp, timestamp);
  });
});
