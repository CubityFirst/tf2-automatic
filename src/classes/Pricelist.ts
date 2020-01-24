import { Currency } from '../types/TeamFortress2';
import { UnknownDictionary } from '../types/common';

import { EventEmitter } from 'events'
import moment from 'moment';
import Currencies from 'tf2-currencies';
import SKU from 'tf2-sku';
import { getPricelist, getPrice } from '../lib/ptf-api';
import schemaManager from '../lib/tf2-schema';
import socket from '../lib/ptf-socket';

const maxAge = parseInt(process.env.MAX_PRICE_AGE) || 8 * 60 * 60;

export class PricelistEntry {
    sku: string;
    enabled: boolean;
    autoprice: boolean;
    max: number;
    min: number;
    intent: 0|1|2;
    buy: Currencies;
    sell: Currencies;
    time: number|null;

    constructor (entry: { sku: string, enabled: boolean, autoprice: boolean, max: number, min: number, intent: 0|1|2, buy: Currency, sell: Currency, time: number|null }) {
        this.sku = entry.sku;
        this.enabled = entry.enabled;
        this.autoprice = entry.autoprice;
        this.max = entry.max;
        this.min = entry.min;
        this.intent = entry.intent;
        this.buy = new Currencies(entry.buy);
        this.sell = new Currencies(entry.sell);
        this.time = entry.time;
    }
}

export default class Pricelist extends EventEmitter {
    private prices: PricelistEntry[];
    private keyPrices: { buy: Currencies, sell: Currencies };

    constructor () {
        super();

        socket.removeListener('price', this.handlePriceChange);
        socket.on('price', this.handlePriceChange);
    }

    getKeyPrices () {
        return this.keyPrices;
    }

    getKeyPrice (): Currencies {
        return this.keyPrices.sell;
    }

    getPrice (sku: string, onlyEnabled = false): PricelistEntry|null {
        // Index of of item in pricelist
        const index = this.getIndex(sku);

        if (index === -1) {
            // Did not find a match
            return null;
        }

        const match = this.prices[index];

        if (onlyEnabled && !match.enabled) {
            // Item is not enabled
            return null;
        }

        return match;
    }

    async addPrice (entry: PricelistEntry, emitChange: boolean): Promise<PricelistEntry> {
        if (entry.autoprice) {
            const price = await getPrice(entry.sku, 'bptf');

            entry.buy = new Currencies(price.buy);
            entry.sell = new Currencies(price.sell);
            entry.time = price.time;
        }

        const keyPrice = this.getKeyPrice();

        if (entry.buy.toValue(keyPrice.metal) >= entry.sell.toValue(keyPrice.metal)) {
            throw new Error('Sell must be higher than buy');
        }

        // Remove old price
        this.removePrice(entry.sku, false);

        // Add new price
        this.prices.push(entry);

        if (emitChange) {
            this.emit('price', entry.sku, entry);
        }

        return entry;
    }

    removePrice (sku: string, emitChange: boolean): void {
        const index = this.getIndex(sku);

        if (index !== -1) {
            // Found match, remove it
            this.prices.splice(index, 1);

            if (emitChange) {
                this.emit('price', sku, null); 
            }
        }
    }

    private getIndex (sku: string): number {
        // Get name of item
        const name = schemaManager.schema.getName(SKU.fromString(sku));

        return this.prices.findIndex((entry) => schemaManager.schema.getName(SKU.fromString(entry.sku)) === name);
    }

    async setPricelist (prices: any): Promise<any> {
        this.prices = prices.map(PricelistEntry);

        const keyPrices = await getPrice('5021;6', 'bptf');

        this.keyPrices = {
            buy: new Currencies(keyPrices.buy),
            sell: new Currencies(keyPrices.sell)
        };

        const old = this.getOld();

        if (old.length === 0) {
            return;
        }

        const pricelist = <any[]>(await getPricelist('bptf')).pricelist;

        const groupedPrices = Pricelist.groupPrices(pricelist);

        let pricesChanged = false;

        // Go through our pricelist
        for (let i = 0; i < old.length; i++) {
            const currPrice = old[i];
            if (currPrice.autoprice !== true) {
                continue;
            }

            const item = SKU.fromString(currPrice.sku);

            // Go through pricestf prices
            for (let j = 0; j < groupedPrices[item.quality][item.killstreak].length; j++) {
                const newestPrice = groupedPrices[item.quality][item.killstreak][j];

                if (schemaManager.schema.getName(item) === newestPrice.name) {
                    // Found matching items
                    if (currPrice.time < newestPrice.time) {
                        // Times don't match, update our price
                        currPrice.buy = new Currencies(newestPrice.buy);
                        currPrice.sell = new Currencies(newestPrice.sell);
                        currPrice.time = newestPrice.time;

                        pricesChanged = true;
                    }

                    // When a match is found remove it from the ptf pricelist
                    groupedPrices[item.quality][item.killstreak].splice(j, 1);
                    break;
                }
            }
        }
    }

    private handlePriceChange (data: any) {
        if (data.soure !== 'bptf') {
            return;
        }

        if (data.sku === '5021;6') {
            this.keyPrices = {
                buy: new Currencies(data.buy),
                sell: new Currencies(data.sell)
            };
        }

        const match = this.getPrice(data.sku);
        if (match !== null && match.autoprice) {
            match.buy = new Currencies(data.buy);
            match.sell = new Currencies(data.sell);
            match.time = data.time;
            this.priceChanged(match);
        }
    }

    private priceChanged (entry: PricelistEntry) {
        this.emit('price', entry);
    }

    private getOld (): PricelistEntry[] {
        if (maxAge <= 0) {
            return this.prices;
        }

        const now = moment().unix();

        return this.prices.filter((entry) => entry.time + maxAge <= now);
    }

    static groupPrices (prices: any[]): UnknownDictionary<UnknownDictionary<any[]>> {
        const sorted: UnknownDictionary<UnknownDictionary<any[]>> = {};

        for (let i = 0; i < prices.length; i++) {
            if (prices[i].buy === null) {
                continue;
            }

            const item = SKU.fromString(prices[i].sku);

            if (!sorted[item.quality]) {
                // Group is not defined yet
                sorted[item.quality] = {};
            }

            if (sorted[item.quality][item.killstreak] !== undefined) {
                sorted[item.quality][item.killstreak].push(prices[i]);
            } else {
                sorted[item.quality][item.killstreak] = [prices[i]];
            }
        }

        return sorted;
    }
}