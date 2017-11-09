/*!
 * pos.js - BlackCoin POS
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * Copyright (c) 2017, Janko33 (MIT License).
 */

'use strict';

const digest = require('../crypto/digest');
const StaticWriter = require('../utils/staticwriter');
const BN = require('../crypto/bn');
const consensus = require('../protocol/consensus');
const util = require('../utils/util');

function Pos() {
  if (!(this instanceof Pos))
    return new Pos();

}

// BlackCoin kernel protocol v3
// coinstake must meet hash target according to the protocol:
// kernel (input 0) must meet the formula
//     hash(nStakeModifier + txPrev.nTime + txPrev.vout.hash + txPrev.vout.n + nTime) < bnTarget * nWeight
// this ensures that the chance of getting a coinstake is proportional to the
// amount of coins one owns.
// The reason this hash is chosen is the following:
//   nStakeModifier: scrambles computation to make it very difficult to precompute
//                   future proof-of-stake
//   txPrev.nTime: slightly scrambles computation
//   txPrev.vout.hash: hash of txPrev, to reduce the chance of nodes
//                     generating coinstake at the same time
//   txPrev.vout.n: output number of txPrev, to reduce the chance of nodes
//                  generating coinstake at the same time
//   nTime: current timestamp
//   block/tx hash should not be used here as they can be generated in vast
//   quantities so as to generate blocks faster, degrading the system back into
//   a proof-of-work situation.
//
Pos.prototype.checkStakeKernelHash = async function checkStakeKernelHash(prev, blkbits, coin, previousout, timeTx) {
  let blkheight = prev.height + 1;

  if (!coin)
    return false;

  if((blkheight - coin.height) < consensus.STAKE_MIN_CONFIRMATIONS)
    return false;

  let nValueIn = coin.getOutput(previousout.index).value;
  if (nValueIn === 0)
    return false;

  let bnTarget = consensus.fromCompact(blkbits);
  let proofOfStake = new StaticWriter(32 + 4 + 32 + 4 + 4);
  proofOfStake.writeHash(prev.stakeModifier);
  proofOfStake.writeU32(coin.nTime);
  proofOfStake.writeHash(previousout.hash);
  proofOfStake.writeU32(previousout.index);
  proofOfStake.writeU32(timeTx);
  let proofOfStakeHash = digest.hash256(proofOfStake.data).toString('hex');

  let hashProofOfStake = new BN(proofOfStakeHash, 'le');
  let bgnValueIn = new BN(nValueIn, 10);
  let weight = hashProofOfStake.div(bgnValueIn);
  return weight.cmp(bnTarget) <= 0;

};

Pos.prototype.computeStakeModifier = function computeStakeModifier(prevStakeModifier, kernel) {
  let newStakeMod = new StaticWriter(64);
  newStakeMod.writeHash(Buffer.from(util.hexToBytes(kernel)));
  newStakeMod.writeHash(Buffer.from(util.hexToBytes(prevStakeModifier)));
  return digest.hash256(newStakeMod.data).toString('hex');
};

/*
 * Expose
 */

module.exports = Pos;
