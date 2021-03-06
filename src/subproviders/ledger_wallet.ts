import * as _ from 'lodash';
import Web3 = require('web3');
import * as EthereumTx from 'ethereumjs-tx';
import ethUtil = require('ethereumjs-util');
import * as ledger from 'ledgerco';
import HookedWalletSubprovider = require('web3-provider-engine/subproviders/hooked-wallet');
import {
    LedgerCommunicationFactory,
    SignPersonalMessageParams,
    TxParams,
    LedgerSubproviderConfigs,
} from '../types';
import { LedgerEthConnection } from '../ledger_eth_connection';
import dbg from 'debug';
const debug = dbg('0x:ledger-wallet');

const DEFAULT_DERIVATION_PATH= `44'/60'/0'`
const NUM_ADDRESSES_TO_FETCH = 2;
const ASK_FOR_ON_DEVICE_CONFIRMATION = false;
const SHOULD_GET_CHAIN_CODE = false;

export class LedgerWallet {
    public getAccounts: (callback: (err: Error, accounts: string[]) => void) => void;
    public signMessage: (msgParams: SignPersonalMessageParams,
        callback: (err: Error, result?: string) => void) => void;
    public signTransaction: (txParams: TxParams,
            callback: (err: Error, result?: string) => void) => void;
    private _network: number;
    private _derivationPath: string;
    private _derivationPathIndex: number;
    private _ledgerEthConnection: LedgerEthConnection;
    private _shouldAlwaysAskForConfirmation: boolean;
    private _shouldGetChainCode: boolean;
    constructor(config: LedgerSubproviderConfigs) {
        this._network = config.networkId;
        this._ledgerEthConnection = config.ledgerConnection;
        this._derivationPath = config.derivationPath || DEFAULT_DERIVATION_PATH;
        this._shouldAlwaysAskForConfirmation = config.shouldAskForOnDeviceConfirmation || ASK_FOR_ON_DEVICE_CONFIRMATION;
        this._derivationPathIndex = config.derivationPathIndex || 0;
        this._shouldGetChainCode = SHOULD_GET_CHAIN_CODE;
        this.getAccounts = this.getAccountsAsync.bind(this);
        this.signMessage = this.signPersonalMessageAsync.bind(this);
        this.signTransaction = this.signTransactionAsync.bind(this);
    }
    public getPath(): string {
        return this._derivationPath;
    }
    private getDerivationPath() {
        const derivationPath = `${this.getPath()}/${this._derivationPathIndex}`;
        return derivationPath;
    }
    public setPath(derivationPath: string) {
        this._derivationPath = derivationPath;
        // HACK: Must re-assign getAccounts, signMessage and signTransaction since they were
        // previously bound to old values of this.path
        this.getAccounts = this.getAccountsAsync.bind(this);
        this.signMessage = this.signPersonalMessageAsync.bind(this);
        this.signTransaction = this.signTransactionAsync.bind(this);
    }
    public setPathIndex(pathIndex: number) {
        this._derivationPathIndex = pathIndex;
        // HACK: Must re-assign signMessage & signTransaction since they it was previously bound to
        // old values of this.path
        this.signMessage = this.signPersonalMessageAsync.bind(this);
        this.signTransaction = this.signTransactionAsync.bind(this);
    }
    public async testConnection(timeout: number, callback: (error?: Error, connected?: boolean) => void): Promise<void> {
        let locked = false;
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, timeout));
        const derivationPath = `${this._derivationPath}/0`;
        const connectionPromise = this._ledgerEthConnection.getAddress_async(derivationPath, false, false);
        connectionPromise.then(() =>     { (locked || callback(undefined, true)); locked = true })
                         .catch((err) => { (locked || callback(err, false));      locked = true });
        timeoutPromise.then(() =>     { (locked || callback(undefined, false));  locked = true })
                      .catch((err) => { (locked || callback(err, false));        locked = true });
        Promise.race([connectionPromise, timeoutPromise])
    }
    public async isSupported(callback: (error?: Error, supported?: boolean) => void): Promise<void> {
        callback(undefined, true);
    }
    public async getAccountsAsync(callback: (err?: Error, accounts?: string[]) => void): Promise<void> {
        const accounts = [];
        for (let i = 0; i < NUM_ADDRESSES_TO_FETCH; i++) {
            try {
                const derivationPath = `${this._derivationPath}/${i + this._derivationPathIndex}`;
                const result = await this._ledgerEthConnection.getAddress_async(
                    derivationPath, this._shouldAlwaysAskForConfirmation, this._shouldGetChainCode,
                );
                accounts.push(result.address.toLowerCase());
            } catch (err) {
                debug('get-accounts:error', err);
                callback(err, undefined);
                return;
            }
        }
        callback(undefined, accounts);
    }
    public async signTransactionAsync(txParams: TxParams, callback: (err?: Error, result?: string) => void) : Promise<void> {
        debug('sign-transaction', txParams);
        const tx = new EthereumTx(txParams);
        
        // Set the EIP155 bits
        tx.raw[6] = Buffer.from([this._network]);  // v
        tx.raw[7] = Buffer.from([]);         // r
        tx.raw[8] = Buffer.from([]);         // s
        
        const txHex = tx.serialize().toString('hex');
        try {
            const derivationPath = this.getDerivationPath();
            const result = await this._ledgerEthConnection.signTransaction_async(derivationPath, txHex);
            // Store signature in transaction
            tx.r = Buffer.from(result.r, 'hex');
            tx.s = Buffer.from(result.s, 'hex');
            tx.v = Buffer.from(result.v, 'hex');
        
            // EIP155: v should be chain_id * 2 + {35, 36}
            const signedChainId = Math.floor((tx.v[0] - 35) / 2);
            if (signedChainId !== this._network) {
                debug('error: "TOO_OLD_LEDGER_FIRMWARE" ', signedChainId);
                const err = new Error('TOO_OLD_LEDGER_FIRMWARE');
                callback(err, undefined);
                return;
            }
        
            const signedTxHex = `0x${tx.serialize().toString('hex')}`;
            callback(undefined, signedTxHex);
        } catch (err) {
            debug('sign-transaction:error', err);
            callback(err, undefined);
        }
    }
    public async signPersonalMessageAsync(msgParams: SignPersonalMessageParams,
                                          callback: (err?: Error, result?: string) => void): Promise<void> {
        debug('sign-personal-message', msgParams);
        let addressIndex = 0;
        try {
            if (!_.isUndefined(msgParams.from)) {
                addressIndex = await this.findAddressIndex(msgParams.from, 10);
            }
            const derivationPath = `${this._derivationPath}/${addressIndex}`;
            const address = await this._ledgerEthConnection.getAddress_async(
                derivationPath, this._shouldAlwaysAskForConfirmation, this._shouldGetChainCode,
            );
            debug('sign-address', address);
            const result = await this._ledgerEthConnection.signPersonalMessage_async(
                derivationPath, ethUtil.stripHexPrefix(msgParams.data));
            const v = _.parseInt(result.v) - 27;
            let vHex = v.toString(16);
            if (vHex.length < 2) {
                vHex = `0${v}`;
            }
            const signature = `0x${result.r}${result.s}${vHex}`;
            debug('signature', signature);
            callback(undefined, signature);
        } catch (err) {
            debug('sign-personal-message:error', err);
            callback(err, undefined);
        }
    }
    private async findAddressIndex(address: string, maxTries: number): Promise<number> {
        for (let i = 0; i < maxTries; i++) {
            try {
                const derivationPath = `${this._derivationPath}/${i + this._derivationPathIndex}`;
                const result = await this._ledgerEthConnection.getAddress_async(
                    derivationPath, this._shouldAlwaysAskForConfirmation, this._shouldGetChainCode,
                );
                const matched = address.toLowerCase() === result.address.toLowerCase();
                if (matched) {
                    return i;
                }
            } catch (err) {
                debug('find-address', err);
                throw err;
            }
        }
        throw Error('Exhasuted max tries searching for address');
    }
}

export const wrapWalletSubproviderFactory = (wallet: LedgerWallet): LedgerWallet => {
    const subProvider = new HookedWalletSubprovider(wallet) as LedgerWallet;
    subProvider.getPath = wallet.getPath.bind(wallet);
    subProvider.setPath = wallet.setPath.bind(wallet);
    subProvider.setPathIndex = wallet.setPathIndex.bind(wallet);
    return subProvider;
}
export const ledgerWalletSubproviderFactory = (ledgerEthConnection: LedgerEthConnection, network: number): LedgerWallet => {
    const ledgerConnectionParams = { ledgerConnection: ledgerEthConnection, networkId: network }
    const wallet = new LedgerWallet(ledgerConnectionParams);
    return wrapWalletSubproviderFactory(wallet);
}