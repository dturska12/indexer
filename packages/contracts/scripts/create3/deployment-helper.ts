/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-console */

import { Interface } from "@ethersproject/abi";
import { Contract } from "@ethersproject/contracts";
import { keccak256 } from "@ethersproject/solidity";
import * as Addresses from "@reservoir0x/sdk/src/router/v6/addresses";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import hre, { ethers } from "hardhat";

export class DeploymentHelper {
  public deployer: SignerWithAddress;
  public chainId: number;

  private constructor(deployer: SignerWithAddress, chainId: number) {
    this.deployer = deployer;
    this.chainId = chainId;
  }

  public static async getInstance(): Promise<DeploymentHelper> {
    const [deployer] = await ethers.getSigners();
    const chainId = await deployer.getChainId();
    return new DeploymentHelper(deployer, chainId);
  }

  public async deploy(contractName: string, version: string, args: any[] = []) {
    // https://github.com/lifinance/create3-factory
    const create3Factory = new Contract(
      "0x93FEC2C00BfE902F733B57c5a6CeeD7CD1384AE1",
      new Interface([
        `
          function deploy(
            bytes32 salt,
            bytes memory creationCode
          ) returns (address)
        `,
        `
          function getDeployed(
            address deployer,
            bytes32 salt
          ) view returns (address)
        `,
      ]),
      this.deployer
    );

    const salt = keccak256(["string", "string"], [contractName, version]);
    const creationCode = await ethers
      .getContractFactory(contractName, this.deployer)
      .then((factory) => factory.getDeployTransaction(...args).data);

    await create3Factory.deploy(salt, creationCode);

    const deploymentAddress: string = await create3Factory.getDeployed(this.deployer.address, salt);
    return deploymentAddress;
  }

  public async verify(contractAddress: string, args: any[]) {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: args,
    });
  }
}

// const main = async () => {
//   const deploymentHelper = await DeploymentHelper.getInstance();
//   const chainId = await deploymentHelper.deployer.getChainId();

//   const args: any[] = [
//     deploymentHelper.deployer.address,
//     "0xb69D7A3C1d9aa9da38AE3e088f60EB6cf7df6A26",
//   ];
//   await deploymentHelper.deploy("SeaportV14Module", "v1", args, { verifyOnEtherscan: true });
// };

// main()
//   .then(() => process.exit(0))
//   .catch((error) => {
//     console.error(error);
//     process.exit(1);
//   });