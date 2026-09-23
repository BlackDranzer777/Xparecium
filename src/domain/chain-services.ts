import type { NodeBase } from './types';
import type { NumericSetting } from './data-services';

/**
 * The blockchain components (entry 076).
 *
 * Six pieces a blockchain application draws: the person's wallet, the RPC
 * node the app talks to the chain through, the smart contract on the chain
 * itself, an indexer that makes the chain searchable, an oracle that brings
 * outside data on-chain, and decentralised file storage.
 *
 * What makes a chain different from everything else on the canvas, and what
 * the models are built to show: a write is not done when it is sent. It waits
 * in a pending pool for the next block, a block holds a fixed amount of gas,
 * and the price of that gas rises by the protocol's own rule whenever blocks
 * are more than half full. Reads never touch the chain: a node answers them
 * from its copy.
 *
 * None of this runs a real chain, signs a real transaction or holds a key.
 */
const n = (label: string, value: number, min: number, max: number, unit?: string, integer = false): NumericSetting => ({ label, value, min, max, unit, integer });

export const CHAIN_SERVICES = {
  wallet: {
    label: 'Wallet', examples: 'MetaMask · Coinbase Wallet · Rainbow',
    description: 'Where a person reviews and signs a transaction before it goes to the chain. Place it between Users and your app or RPC node. Only actions that change something need a signature; reading passes straight through. People take seconds to sign, and some change their mind. Each person signs in their own wallet, so there is no shared queue.',
    fields: {
      serviceTimeMs: n('Time to review and sign', 4000, 0, 600000, 'ms'),
      transactionShare: n('Actions that need a signature (0–1)', 0.3, 0, 1),
      rejectShare: n('Signatures refused or abandoned (0–1)', 0.05, 0, 1),
    },
  },
  rpcNode: {
    label: 'RPC node', examples: 'Alchemy · Infura · QuickNode · your own Geth node',
    description: 'The doorway between an app and the chain. It answers reads from its own copy of the chain and forwards signed transactions to it. A hosted node has a plan limit: above it, requests are refused, not queued. Connect Users (through a Wallet) to it, and connect it to the Smart contract. It is the only thing an RPC node calls.',
    fields: {
      requestMs: n('Time per request', 20, 0, 600000, 'ms'),
      maxConcurrentRequests: n('Requests handled at once', 200, 1, 1000000, undefined, true),
      ratePerSecond: n('Plan limit (requests per second)', 500, 0.001, 10000000),
      burstCapacity: n('Burst allowance', 500, 1, 10000000, undefined, true),
    },
  },
  smartContract: {
    label: 'Smart contract', examples: 'Ethereum · Polygon · Arbitrum · Base',
    description: 'Code and data on a blockchain. A transaction waits in the pending pool for the next block, and is done only after the blocks you wait for; a block holds a fixed amount of gas, shared with everyone else using the chain. When blocks are more than half full the base fee rises, by the protocol’s own rule, and falls when they are emptier; everyone else uses less space as it rises, your own transactions do not. Reads are answered by the node and never wait for a block. Connect a server, function or RPC node to it.',
    fields: {
      writeShare: n('Calls that are transactions (0–1)', 0.3, 0, 1),
      gasPerTx: n('Gas per transaction', 60000, 21000, 30000000, undefined, true),
      blockSeconds: n('Time between blocks', 12, 0.05, 3600, 's'),
      blockGasLimit: n('Gas per block', 30000000, 21000, 10000000000, undefined, true),
      backgroundShare: n('Block space used by everyone else, at the starting fee (0–1)', 0.5, 0, 0.99),
      confirmations: n('Blocks to wait for', 2, 1, 100, undefined, true),
      mempoolLimit: n('Pending transactions limit', 10000, 1, 10000000, undefined, true),
      serviceTimeMs: n('Time to accept a transaction', 1, 0, 600000, 'ms'),
      maxConcurrentRequests: n('Transactions accepted at once', 1000, 1, 1000000, undefined, true),
      queueLimit: n('Waiting submissions limit', 10000, 0, 1000000, undefined, true),
      requestBytes: n('Transaction size', 200, 0, 100000000, 'bytes', true),
      responseBytes: n('Receipt size', 500, 0, 100000000, 'bytes', true),
    },
  },
  indexer: {
    label: 'Blockchain indexer', examples: 'The Graph · Goldsky · your own indexer',
    description: 'A searchable copy of what happened on the chain, so your app can ask “which items does this person own?” without scanning blocks. Connect the Smart contract to it, so it reads every block, and connect a server or function to it to query. Queries are fast; indexing takes time per transaction, so a busy chain can leave it behind.',
    fields: {
      serviceTimeMs: n('Query time', 5, 0, 600000, 'ms'),
      maxConcurrentRequests: n('Parallel queries', 64, 1, 100000, undefined, true),
      queueLimit: n('Waiting queries limit', 1000, 0, 1000000, undefined, true),
      requestBytes: n('Query size', 256, 0, 100000000, 'bytes', true),
      responseBytes: n('Result size', 2048, 0, 100000000, 'bytes', true),
      indexMsPerTx: n('Indexing time per transaction', 20, 0, 600000, 'ms'),
      blockOverheadMs: n('Indexing time per block', 50, 0, 600000, 'ms'),
    },
  },
  oracle: {
    label: 'Oracle', examples: 'Chainlink · Pyth · Chronicle',
    description: 'Brings outside data, like a price, onto the chain. It sends an update transaction on a fixed interval, and each one takes block space like any other transaction. Data on the chain is only as fresh as the last update that made it into a block. Connect it to the Smart contract that reads the data.',
    fields: {
      heartbeatSeconds: n('Update every', 10, 0.1, 86400, 's'),
      gasPerUpdate: n('Gas per update', 100000, 21000, 30000000, undefined, true),
    },
  },
  ipfs: {
    label: 'Decentralised storage', examples: 'IPFS · Filecoin · Arweave · Pinata',
    description: 'Files stored across many computers and found by their content, like NFT images. A gateway answers quickly when it has a file cached; otherwise it must find the file on the network first, which is slow. Uploads are pinned so the file stays available. Connect a server or function to it.',
    fields: {
      serviceTimeMs: n('Gateway time', 30, 0, 600000, 'ms'),
      maxConcurrentRequests: n('Parallel requests', 128, 1, 100000, undefined, true),
      queueLimit: n('Waiting requests limit', 1000, 0, 1000000, undefined, true),
      requestBytes: n('Request size', 256, 0, 100000000, 'bytes', true),
      responseBytes: n('File size', 200000, 0, 1000000000, 'bytes', true),
      writeShare: n('Uploads (0–1)', 0.1, 0, 1),
      gatewayHitShare: n('Reads the gateway has cached (0–1)', 0.8, 0, 1),
      retrievalMs: n('Extra time to find a file on the network', 1500, 0, 600000, 'ms'),
      uploadMs: n('Time to upload and pin', 500, 0, 600000, 'ms'),
      storedGb: n('Pinned data', 10, 0, 10000000, 'GB'),
    },
  },
} as const;

export type ChainKind = keyof typeof CHAIN_SERVICES;
export const CHAIN_KINDS = Object.keys(CHAIN_SERVICES) as ChainKind[];
export const isChainKind = (kind: string): kind is ChainKind => (CHAIN_KINDS as readonly string[]).includes(kind);
export type ChainSettings<K extends ChainKind> = { [P in keyof (typeof CHAIN_SERVICES)[K]['fields']]: number };
export type ChainNode = { [K in ChainKind]: NodeBase & { kind: K; settings: ChainSettings<K> } }[ChainKind];
export type ChainNodeOf<K extends ChainKind> = Extract<ChainNode, { kind: K }>;
/** The chain pieces a server calls, in the order a request calls them: reads first, then the write. */
export const CHAIN_DEPENDENCIES = ['indexer', 'ipfs', 'smartContract'] as const;
/** The chain pieces driven by the shared-service model: a slot, a service time, a bounded line. */
export type ChainServiceNode = ChainNodeOf<'wallet' | 'smartContract' | 'indexer' | 'ipfs'>;
export const isChainServiceKind = (kind: string): kind is ChainServiceNode['kind'] =>
  kind === 'wallet' || kind === 'smartContract' || kind === 'indexer' || kind === 'ipfs';

export function chainDefaults<K extends ChainKind>(kind: K): ChainSettings<K> {
  return Object.fromEntries(Object.entries(CHAIN_SERVICES[kind].fields).map(([key, f]) => [key, f.value])) as ChainSettings<K>;
}
