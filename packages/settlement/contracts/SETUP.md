# Setup

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0
forge build
forge test -vvv           # 15 tests: unit + fuzz(512) + invariant(128 runs / 4096 calls)
forge test --gas-report   # gas per function
```

## Deploy to Base Sepolia (the sandbox)
```bash
export PRIVATE_KEY=0x...        # deployer/owner
export USDC_ADDRESS=0x...       # Circle Base Sepolia USDC (confirm in Circle docs)
export TREASURY=0x... OPERATOR=0x... ATTESTOR=0x... OWNER=0x...
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
```
