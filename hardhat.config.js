import HardhatEthers from "@nomicfoundation/hardhat-ethers";

const config = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    tempo: {
      type: "http",
      url: "https://rpc.tempo.xyz",
      chainId: 4217,
      accounts: process.env.WALLET_PRIVATE_KEY ? [process.env.WALLET_PRIVATE_KEY] : [],
    },
  },
  plugins: [HardhatEthers],
};

export default config;
