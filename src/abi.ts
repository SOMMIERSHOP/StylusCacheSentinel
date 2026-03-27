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
