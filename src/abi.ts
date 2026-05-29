// ArbWasmCache (0x72) + CacheManager ABIs
export const arbWasmCacheAbi = [
  {
    name: "allCacheManagers",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "managers", type: "address[]" }],
  },
  {
    name: "codehashIsCached",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "codehash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const cacheManagerAbi = [
  // views
  {
    name: "cacheSize",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "queueSize",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "decay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "isPaused",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getEntries",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "code", type: "bytes32" },
          { name: "size", type: "uint64" },
          { name: "bid", type: "uint192" },
        ],
      },
    ],
  },
  {
    name: "getMinBid",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "program", type: "address" }],
    outputs: [{ name: "min", type: "uint192" }],
  },

  // events
  {
    name: "InsertBid",
    type: "event",
    inputs: [
      { name: "codehash", type: "bytes32", indexed: true },
      { name: "program", type: "address", indexed: false },
      { name: "bid", type: "uint192", indexed: false },
      { name: "size", type: "uint64", indexed: false },
    ],
  },
  {
    name: "DeleteBid",
    type: "event",
    inputs: [
      { name: "codehash", type: "bytes32", indexed: true },
      { name: "bid", type: "uint192", indexed: false },
      { name: "size", type: "uint64", indexed: false },
    ],
  },
  {
    name: "SetCacheSize",
    type: "event",
    inputs: [{ name: "size", type: "uint64", indexed: false }],
  },
  {
    name: "SetDecayRate",
    type: "event",
    inputs: [{ name: "decay", type: "uint64", indexed: false }],
  },
  {
    name: "Pause",
    type: "event",
    inputs: [],
  },
  {
    name: "Unpause",
    type: "event",
    inputs: [],
  },
] as const;

// Write path (M3/M4). Kept separate from cacheManagerAbi so the bytes32
// getMinBid overload never collides with the address overload above when
// viem resolves a call by argument types.
export const cacheManagerWriteAbi = [
  // The deployed CacheManager keys placeBid on the program ADDRESS (it derives
  // the codehash internally and emits it in InsertBid). An earlier
  // placeBid(bytes32) was removed upstream in nitro-contracts (commit f1bb9a5),
  // and the Arbitrum One deployment is post-change — bidding by codehash reverts.
  {
    name: "placeBid",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "program", type: "address" }],
    outputs: [],
  },
  {
    name: "getMinBid",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "codehash", type: "bytes32" }],
    outputs: [{ name: "min", type: "uint192" }],
  },

  // Custom errors the CacheManager can revert with — declared so viem decodes
  // them by name instead of surfacing a raw selector. Used to classify why a
  // getMinBid / placeBid call failed (e.g. a program whose Stylus activation
  // has expired and must be re-activated before it can be cached).
  {
    type: "error",
    name: "ProgramExpired",
    inputs: [{ name: "ageInSeconds", type: "uint64" }],
  },
  { type: "error", name: "ProgramNotActivated", inputs: [] },
  {
    type: "error",
    name: "AlreadyCached",
    inputs: [{ name: "codehash", type: "bytes32" }],
  },
  { type: "error", name: "BidsArePaused", inputs: [] },
  {
    type: "error",
    name: "BidTooSmall",
    inputs: [
      { name: "bid", type: "uint192" },
      { name: "min", type: "uint192" },
    ],
  },
  {
    type: "error",
    name: "AsmTooLarge",
    inputs: [
      { name: "asm", type: "uint256" },
      { name: "queueSize", type: "uint256" },
      { name: "cacheSize", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "MakeSpaceTooLarge",
    inputs: [
      { name: "size", type: "uint64" },
      { name: "limit", type: "uint64" },
    ],
  },
] as const;
