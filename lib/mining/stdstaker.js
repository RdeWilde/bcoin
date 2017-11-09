/*!
 * cpuminer.js - inefficient cpu miner for bcoin (because we can)
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const util = require('../utils/util');
const co = require('../utils/co');
const AsyncObject = require('../utils/asyncobject');
const mine = require('./mine');
const secp256k1 = require('../crypto/secp256k1');
const Lock = require('../utils/lock');
const consensus = require('../protocol/consensus');
const BN = require('../crypto/bn');
const MTX = require('../primitives/mtx');

/**
 * CPU miner.
 * @alias module:mining.STDStaker
 * @constructor
 * @param {Staker} miner
 * @emits STDStaker#block
 * @emits STDStaker#status
 */

function STDStaker(miner) {
  if (!(this instanceof STDStaker))
    return new STDStaker(miner);

  AsyncObject.call(this);

  this.miner = miner;
  this.network = this.miner.network;
  this.logger = this.miner.logger.context('cpuminer');
  this.workers = this.miner.workers;
  this.chain = this.miner.chain;
  this.locker = new Lock();

  this.running = false;
  this.stopping = false;
  this.job = null;
  this.stopJob = null;
  this.wallet = null;
  this.account = null;
  this.walletdb = this.miner.walletdb;
  this._init();
}

util.inherits(STDStaker, AsyncObject);

/**
 * Nonce range interval.
 * @const {Number}
 * @default
 */

STDStaker.INTERVAL = 0xffffffff / 1500 | 0;

/**
 * Initialize the miner.
 * @private
 */

STDStaker.prototype._init = function _init() {
  this.chain.on('tip', (tip) => {
    if (!this.job)
      return;

    if (this.job.attempt.prevBlock === tip.prevBlock)
      this.job.destroy();
  });
};

/**
 * Open the miner.
 * @method
 * @alias module:mining.STDStaker#open
 * @returns {Promise}
 */

STDStaker.prototype._open = async function open() {
  await this.walletdb.open();

  this.wallet = await this.walletdb.create();

  console.log('Created wallet');
  console.log(this.wallet);

  this.account = await this.wallet.createAccount({
    name: 'stakingAccount'
  });

  console.log('Created account');
  console.log(this.account);
};

/**
 * Close the miner.
 * @method
 * @alias module:mining.STDStaker#close
 * @returns {Promise}
 */

STDStaker.prototype._close = async function close() {
  await this.stop();
};

/**
 * Start mining.
 * @method
 */

STDStaker.prototype.start = function start() {
  assert(!this.running, 'Miner is already running.');
  this._start().catch(() => {});
};

/**
 * Start mining.
 * @method
 * @private
 * @returns {Promise}
 */

STDStaker.prototype._start = async function start() {
  let job;

  assert(!this.running, 'Miner is already running.');

  this.running = true;
  this.stopping = false;

  for (;;) {
    let block, entry;

    this.job = null;

    try {
      this.job = await this.createJob();
    } catch (e) {
      if (this.stopping)
        break;
      this.emit('error', e);
      break;
    }

    if (this.stopping)
      break;

    try {
      block = await this.mineAsync(this.job);
    } catch (e) {
      if (this.stopping)
        break;
      this.emit('error', e);
      break;
    }

    if (this.stopping)
      break;

    if (!block)
      continue;

    try {
      entry = await this.chain.add(block);
    } catch (e) {
      if (this.stopping)
        break;

      if (e.type === 'VerifyError') {
        this.logger.warning('Mined an invalid block!');
        this.logger.error(e);
        continue;
      }

      this.emit('error', e);
      break;
    }

    if (!entry) {
      this.logger.warning('Mined a bad-prevblk (race condition?)');
      continue;
    }

    if (this.stopping)
      break;

    // Log the block hex as a failsafe (in case we can't send it).
    this.logger.info('Found block: %d (%s).', entry.height, entry.rhash());
    this.logger.debug('Raw: %s', block.toRaw().toString('hex'));

    this.emit('block', block, entry);
  }

  job = this.stopJob;

  if (job) {
    this.stopJob = null;
    job.resolve();
  }
};

/**
 * Stop mining.
 * @method
 * @returns {Promise}
 */

STDStaker.prototype.stop = async function stop() {
  let unlock = await this.locker.lock();
  try {
    return await this._stop();
  } finally {
    unlock();
  }
};

/**
 * Stop mining (without a lock).
 * @method
 * @returns {Promise}
 */

STDStaker.prototype._stop = async function _stop() {
  if (!this.running)
    return;

  assert(this.running, 'Miner is not running.');
  assert(!this.stopping, 'Miner is already stopping.');

  this.stopping = true;

  if (this.job) {
    this.job.destroy();
    this.job = null;
  }

  await this.wait();

  this.running = false;
  this.stopping = false;
  this.job = null;
};

/**
 * Wait for `done` event.
 * @private
 * @returns {Promise}
 */

STDStaker.prototype.wait = function wait() {
  return new Promise((resolve, reject) => {
    assert(!this.stopJob);
    this.stopJob = co.job(resolve, reject);
  });
};

/**
 * Create a mining job.
 * @method
 * @param {ChainEntry?} tip
 * @param {Address?} address
 * @returns {Promise} - Returns {@link Job}.
 */

STDStaker.prototype.createJob = async function createJob(tip, address) {
  let attempt = await this.miner.createBlock(tip, address);
  return new STDJob(this, attempt);
};

/**
 * Mine a single block.
 * @method
 * @param {ChainEntry?} tip
 * @param {Address?} address
 * @returns {Promise} - Returns [{@link Block}].
 */

STDStaker.prototype.mineBlock = async function mineBlock(tip, address) {
  let job = await this.createJob(tip, address);
  return await this.mineAsync(job);
};

/**
 * Notify the miner that a new
 * tx has entered the mempool.
 */

STDStaker.prototype.notifyEntry = function notifyEntry() {
  if (!this.running)
    return;

  if (!this.job)
    return;

  if (util.now() - this.job.start > 10) {
    this.job.destroy();
    this.job = null;
  }
};

/**
 * Hash until the nonce overflows.
 * @param {STDJob} job
 * @returns {Number} nonce
 */

STDStaker.prototype.doStakeAsync = async function doStakeAsync(job) {
  let prev = this.chain.tip;
  let prevOut, stakeCoin;
  let nTime = 0;
  let foundKernel = false;

  let account = this.wallet.getAccount('stakingAccount');
  let coins = this.wallet.getCoins(account);
  for (;;) {
    // every 16s
    if(nTime !== 0 && nTime + 16 === util.now())
      continue;
    nTime = util.now() & ~15;
    for (let coin of coins) {
      let txPrev = this.chain.db.getCoins(coin.hash);
      let target = consensus.toCompact(new BN(prevOut.value, 10));
      foundKernel = this.pos.checkStakeKernelHash(prev, target, txPrev, coin, nTime);
      if (foundKernel) {
        stakeCoin = coin;
        break;
      }

    }

    if (foundKernel)
      break;

  }

  let stakedblock = job.commitCnTxTime(nTime, stakeCoin);
  let mtx = new MTX();
  mtx = mtx.fromTX(stakedblock.txs[1]);
  this.wallet.sign(mtx);
  stakedblock.txs[1] = mtx.toTX();

  let privateKey = this.wallet.getPrivateKey(stakeCoin.script.getAddress());
  let blockSig = secp256k1.sign(stakedblock.hash(), privateKey, { canonical: true });
  stakedblock.signature = blockSig;
  return stakedblock;
};

/**
 * Hash until the nonce overflows.
 * @param {STDJob} job
 * @returns {Number} nonce
 */

STDStaker.prototype.doStake = function doStake(job) {
  let prev = this.chain.tip;
  let prevOut, stakeCoin;
  let nTime = 0;
  let foundKernel = false;

  let account = this.wallet.getAccount('stakingAccount');
  let coins = this.wallet.getCoins(account);
  for (;;) {
    // every 16s
    if(nTime !== 0 && nTime + 16 === util.now())
      continue;
    nTime = util.now() & ~15;
    for (let coin of coins) {
      let txPrev = this.chain.db.getCoins(coin.hash);
      let target = consensus.toCompact(new BN(prevOut.value, 10));
      foundKernel = this.pos.checkStakeKernelHash(prev, target, txPrev, coin, nTime);
      if (foundKernel) {
        stakeCoin = coin;
        break;
      }

    }

    if (foundKernel)
      break;

  }

  let stakedblock = job.commitCnTxTime(nTime, stakeCoin);
  let mtx = new MTX();
  mtx = mtx.fromTX(stakedblock.txs[1]);
  this.wallet.sign(mtx);
  stakedblock.txs[1] = mtx.toTX();

  let privateKey = this.wallet.getPrivateKey(stakeCoin.script.getAddress());
  let blockSig = secp256k1.sign(stakedblock.hash(), privateKey, { canonical: true });
  stakedblock.signature = blockSig;
  return stakedblock;
};

/**
 * Hash until the nonce overflows.
 * @param {STDJob} job
 * @returns {Number} nonce
 */

STDStaker.prototype.findNonce = function findNonce(job) {
  let data = job.getHeader();
  let target = job.attempt.target;
  let interval = STDStaker.INTERVAL;
  let min = 0;
  let max = interval;
  let nonce;

  while (max <= 0xffffffff) {
    nonce = mine(data, target, min, max);

    if (nonce !== -1)
      break;

    this.sendStatus(job, max);

    min += interval;
    max += interval;
  }

  return nonce;
};

/**
 * Hash until the nonce overflows.
 * @method
 * @param {STDJob} job
 * @returns {Promise} Returns Number.
 */

STDStaker.prototype.findNonceAsync = async function doStakeAsync(job) {
  let data = job.getHeader();
  let target = job.attempt.target;
  let interval = STDStaker.INTERVAL;
  let min = 0;
  let max = interval;
  let nonce;

  if (!this.workers)
    return this.findNonce(job);

  while (max <= 0xffffffff) {
    nonce = await this.workers.mine(data, target, min, max);

    if (nonce !== -1)
      break;

    if (job.destroyed)
      return nonce;

    this.sendStatus(job, max);

    min += interval;
    max += interval;
  }

  return nonce;
};

/**
 * Hash until the nonce overflows.
 * @method
 * @param {STDJob} job
 * @returns {Promise} Returns Number.
 */

STDStaker.prototype.findNonceAsync = async function findNonceAsync(job) {
  let data = job.getHeader();
  let target = job.attempt.target;
  let interval = STDStaker.INTERVAL;
  let min = 0;
  let max = interval;
  let nonce;

  if (!this.workers)
    return this.findNonce(job);

  while (max <= 0xffffffff) {
    nonce = await this.workers.mine(data, target, min, max);

    if (nonce !== -1)
      break;

    if (job.destroyed)
      return nonce;

    this.sendStatus(job, max);

    min += interval;
    max += interval;
  }

  return nonce;
};

/**
 * Mine synchronously until the block is found.
 * @param {STDJob} job
 * @returns {Block}
 */

STDStaker.prototype.mine = function mine(job) {
  let coinstakeTx;

  job.start = util.now();

  for (;;) {
    coinstakeTx = this.doStake(job);

    if (coinstakeTx !== -1)
      break;

    job.updateCoinstakeTx();

    this.sendStatus(job, 0);
  }

  return job.commit(coinstakeTx);
};

/**
 * Mine asynchronously until the block is found.
 * @method
 * @param {STDJob} job
 * @returns {Promise} - Returns {@link Block}.
 */

STDStaker.prototype.mineAsync = async function mineAsync(job) {
  let nonce;

  job.start = util.now();

  for (;;) {
    nonce = await this.findNonceAsync(job);

    if (nonce !== -1)
      break;

    if (job.destroyed)
      return;

    job.updateNonce();

    this.sendStatus(job, 0);
  }

  return job.commit(nonce);
};

/**
 * Send a progress report (emits `status`).
 * @param {STDJob} job
 * @param {Number} nonce
 */

STDStaker.prototype.sendStatus = function sendStatus(job, nonce) {
  let attempt = job.attempt;
  let tip = util.revHex(attempt.prevBlock);
  let hashes = job.getHashes(nonce);
  let hashrate = job.getRate(nonce);

  this.logger.info(
    'Status: hashrate=%dkhs hashes=%d target=%d height=%d tip=%s',
    Math.floor(hashrate / 1000),
    hashes,
    attempt.bits,
    attempt.height,
    tip);

  this.emit('status', job, hashes, hashrate);
};

/**
 * Mining Job
 * @constructor
 * @ignore
 * @param {STDStaker} miner
 * @param {BlockTemplate} attempt
 */

function STDJob(miner, attempt) {
  this.miner = miner;
  this.attempt = attempt;
  this.destroyed = false;
  this.committed = false;
  this.start = util.now();
  this.nonce1 = 0;
  this.nonce2 = 0;
  this.refresh();
}

/**
 * Get the raw block header.
 * @param {Number} nonce
 * @returns {Buffer}
 */

STDJob.prototype.getHeader = function getHeader() {
  let attempt = this.attempt;
  let n1 = this.nonce1;
  let n2 = this.nonce2;
  let ts = attempt.ts;
  let root = attempt.getRoot(n1, n2);
  let data = attempt.getHeader(root, ts, 0);
  return data;
};

/**
 * Commit job and return a block.
 * @param {Number} nonce
 * @returns {Block}
 */

STDJob.prototype.commit = function commit(nonce) {
  let attempt = this.attempt;
  let n1 = this.nonce1;
  let n2 = this.nonce2;
  let ts = attempt.ts;
  let proof;

  assert(!this.committed, 'Job already committed.');
  this.committed = true;

  proof = attempt.getProof(n1, n2, ts, nonce);

  return attempt.commit(proof);
};

/**
* commitCnTxTime job and return a block.
* @param {Number} stakeTime
* @returns {Block}
*/

STDJob.prototype.commitCnTxTime = function commitCnTxTime(nTime, stakeCoin) {
  assert(!this.committed, 'Job already committed.');
  this.committed = true;

  return this.attempt.commitCnTxTime(nTime, stakeCoin);
};

/**
 * Mine block synchronously.
 * @returns {Block}
 */

STDJob.prototype.mine = function mine() {
  return this.miner.mine(this);
};

/**
 * Mine block asynchronously.
 * @returns {Promise}
 */

STDJob.prototype.mineAsync = function mineAsync() {
  return this.miner.mineAsync(this);
};

/**
 * Stake block asynchronously.
 * @returns {Promise}
 */

STDJob.prototype.stakeAsync = function stakeAsync() {
  return this.miner.doStakeAsync(this);
};

/**
 * Refresh the block template.
 */

STDJob.prototype.refresh = function refresh() {
  return this.attempt.refresh();
};

/**
 * Increment the extraNonce.
 */

STDJob.prototype.updateNonce = function updateNonce() {
  if (++this.nonce2 === 0x100000000) {
    this.nonce2 = 0;
    this.nonce1++;
  }
};

/**
 * Destroy the job.
 */

STDJob.prototype.destroy = function destroy() {
  assert(!this.destroyed, 'Job already destroyed.');
  this.destroyed = true;
};

/**
 * Calculate number of hashes computed.
 * @param {Number} nonce
 * @returns {Number}
 */

STDJob.prototype.getHashes = function getHashes(nonce) {
  let extra = this.nonce1 * 0x100000000 + this.nonce2;
  return extra * 0xffffffff + nonce;
};

/**
 * Calculate hashrate.
 * @param {Number} nonce
 * @returns {Number}
 */

STDJob.prototype.getRate = function getRate(nonce) {
  let hashes = this.getHashes(nonce);
  let seconds = util.now() - this.start;
  return Math.floor(hashes / seconds);
};

/**
 * Add a transaction to the block.
 * @param {TX} tx
 * @param {CoinView} view
 */

STDJob.prototype.addTX = function addTX(tx, view) {
  return this.attempt.addTX(tx, view);
};

/**
 * Add a transaction to the block
 * (less verification than addTX).
 * @param {TX} tx
 * @param {CoinView?} view
 */

STDJob.prototype.pushTX = function pushTX(tx, view) {
  return this.attempt.pushTX(tx, view);
};

/*
 * Expose
 */

module.exports = STDStaker;
