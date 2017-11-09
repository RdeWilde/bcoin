'use strict';

const KeyRing = require('goji/lib/primitives/keyring');
const WorkerPool = require('goji/lib/workers/workerpool');
const Chain = require('goji/lib/blockchain/chain');
const Staker = require('goji/lib/mining/staker');
const WalletDB = require('goji/lib/wallet/walletdb');

const key = KeyRing.generate('regtest');

const workers = new WorkerPool({
  enabled: true
});

const chain = new Chain({
  network: 'regtest',
  workers: workers
});

const walletdb = new WalletDB({
  network: 'main',
  db: 'memory'
});

const staker = new Staker({
  chain: chain,
  walletdb: walletdb,
  addresses: [key.getAddress()],
  coinbaseFlags: 'my-miner',
  workers: workers
});

(async () => {
  let tmpl, job, block;

  await staker.open();

  tmpl = await staker.createBlock();

  console.log('Block template:');
  console.log(tmpl);

  job = await staker.cpu.createJob();
  block = await job.stakeAsync();

  console.log('Mined block:');
  console.log(block);
  console.log(block.txs[0]);

  await chain.add(block);

  console.log('New tip:');
  console.log(chain.tip);
})();
