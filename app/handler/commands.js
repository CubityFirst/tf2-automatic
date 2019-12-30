const dotProp = require('dot-prop');
const pluralize = require('pluralize');
const moment = require('moment');
const SKU = require('tf2-sku');
const Currencies = require('tf2-currencies');

const prices = require('app/prices');
const client = require('lib/client');
const inventory = require('app/inventory');
const schemaManager = require('lib/tf2-schema');
const log = require('lib/logger');
const friends = require('handler/friends');
const trades = require('handler/trades');
const queue = require('handler/queue');

const parseJSON = require('utils/parseJSON');
const isAdmin = require('utils/isAdmin');

let messages = [];

setInterval(function () {
    messages = [];
}, 1000);

function getCommand (string) {
    if (string.startsWith('!')) {
        const command = string.toLowerCase().split(' ')[0].substr(1);
        return command;
    } else {
        return null;
    }
}

function getParams (string) {
    const params = parseJSON('{"' + string.replace(/"/g, '\\"').replace(/&/g, '","').replace(/=/g, '":"') + '"}');

    const parsed = {};

    if (params !== null) {
        for (const key in params) {
            if (!Object.prototype.hasOwnProperty.call(params, key)) {
                continue;
            }

            let value = params[key];

            if (/^\d+$/.test(value)) {
                value = parseInt(value);
            } else if (/^\d+(\.\d+)?$/.test(value)) {
                value = parseFloat(value);
            } else if (value === 'true') {
                value = true;
            } else if (value === 'false') {
                value = false;
            }

            dotProp.set(parsed, key.trim(), value);
        }
    }

    return parsed;
}

exports.handleMessage = function (steamID, message) {
    const admin = isAdmin(steamID);
    const command = getCommand(message);

    const friend = friends.getFriend(steamID.getSteamID64());

    if (friend === null) {
        // We are not friends, ignore the message
        return;
    }

    const steamID64 = steamID.getSteamID64();

    if (messages.indexOf(steamID64) !== -1) {
        return;
    }

    if (!admin) {
        messages.push(steamID64);
    }

    log.info('Message from ' + friend.player_name + ' (' + steamID64 + '): ' + message);

    if (command === 'help') {
        let reply = 'Here\'s a list of all my commands: !help, !how2trade, !price [amount] <name>, !stock, !buy [amount] <name>, !sell [amount] <name>';
        if (isAdmin(steamID)) {
            reply += ', !get, !add, !remove, !update';
        }
        client.chatMessage(steamID, reply);
    } else if (command === 'how2trade') {
        client.chatMessage(steamID, 'Send me a trade offer with the items you want to buy / sell.');
    } else if (command === 'price') {
        const info = getItemAndAmount(steamID, message.substring(command.length + 1).trim());

        if (info === null) {
            return;
        }

        const match = info.match;
        const amount = info.amount;

        let reply = '';

        const isBuying = match.intent === 0 || match.intent === 2;
        const isSelling = match.intent === 1 || match.intent === 2;

        const keyPrices = prices.getKeyPrices();

        const isKey = match.sku === '5021;6';

        if (isBuying) {
            reply = 'I am buying ';

            if (amount !== 1) {
                reply += amount + ' ';
            } else {
                reply += 'a ';
            }

            // If the amount is 1, then don't convert to value and then to currencies. If it is for keys, then don't use conversion rate
            const currencies = amount === 1 ? match.buy : Currencies.toCurrencies(match.buy.toValue(keyPrices.buy.metal) * amount, isKey ? undefined : keyPrices.buy.metal);

            reply += pluralize(match.name, amount) + ' for ' + currencies.toString();
        }

        if (isSelling) {
            const currencies = amount === 1 ? match.sell : Currencies.toCurrencies(match.sell.toValue(keyPrices.sell.metal) * amount, isKey ? undefined : keyPrices.sell.metal);

            if (reply === '') {
                reply = 'I am selling ';

                if (amount !== 1) {
                    reply += amount + ' ';
                } else {
                    reply += 'a ';
                }

                reply += pluralize(match.name, amount) + ' for ' + currencies.toString();
            } else {
                reply += ' and selling for ' + currencies.toString();
            }
        }

        reply += '. I have ' + inventory.getAmount(match.sku);

        if (match.max !== -1 && isBuying) {
            reply += ' / ' + match.max;
        }

        if (isSelling && match.min !== 0) {
            reply += ' and I can sell ' + inventory.amountCanTrade(match.sku, false);
        }

        if (match.autoprice && isAdmin(steamID)) {
            reply += ' (price last updated ' + moment.unix(match.time).fromNow() + ')';
        }

        reply += '.';
        client.chatMessage(steamID, reply);
    } else if (command === 'stock') {
        const dict = inventory.getOwnInventory();

        const items = [];

        for (const sku in dict) {
            if (!Object.prototype.hasOwnProperty.call(dict, sku)) {
                continue;
            }

            if (['5021;6', '5002;6', '5001;6', '5000;6'].indexOf(sku) !== -1) {
                continue;
            }

            items.push({
                name: schemaManager.schema.getName(SKU.fromString(sku)),
                amount: dict[sku].length
            });
        }

        items.sort(function (a, b) {
            if (a.amount === b.amount) {
                if (a.name < b.name) {
                    return -1;
                } else if (a.name > b.name) {
                    return 1;
                } else {
                    return 0;
                }
            }
            return b.amount - a.amount;
        });

        const pure = [{
            name: 'Mann Co. Supply Crate Key',
            amount: inventory.getAmount('5021;6')
        }, {
            name: 'Refined Metal',
            amount: inventory.getAmount('5002;6')
        }, {
            name: 'Reclaimed Metal',
            amount: inventory.getAmount('5001;6')
        }, {
            name: 'Scrap Metal',
            amount: inventory.getAmount('5000;6')
        }];

        const parsed = pure.concat(items);

        const stock = [];
        let left = 0;

        for (let i = 0; i < parsed.length; i++) {
            if (stock.length > 20) {
                left += parsed[i].amount;
            } else {
                stock.push(parsed[i].name + ': ' + parsed[i].amount);
            }
        }

        let reply = 'Here\'s a list of all the items that I have in my inventory:\n' + stock.join(', \n');
        if (left > 0) {
            reply += ',\nand ' + left + ' other ' + pluralize('item', left);
        }
        // reply += '\nYou can see my inventory and prices here: https://backpack.tf/profiles/' + client.steamID.getSteamID64();

        client.chatMessage(steamID, reply);
    } else if (command === 'buy' || command === 'sell') {
        const info = getItemAndAmount(steamID, message.substring(command.length + 1).trim());

        if (info === null) {
            return;
        }

        const buying = command === 'sell';

        const activeOfferID = trades.getActiveOffer(steamID);

        if (activeOfferID !== null) {
            client.chatMessage(steamID, 'You already have an active offer! Please finish it before requesting a new one:  https://steamcommunity.com/tradeoffer/' + activeOfferID + '/');
            return;
        }

        const position = queue.getPosition(steamID);

        if (position !== -1) {
            if (position === 0) {
                client.chatMessage(steamID, 'You are already in the queue! Please wait while I process your offer.');
            } else {
                client.chatMessage(steamID, 'You are already in the queue! Please wait your turn, there ' + (position !== 1 ? 'are' : 'is') + ' ' + position + ' infront of you.');
            }
            return;
        }

        const newPosition = queue.addRequestedTrade(steamID, info.match.sku, info.amount, buying);

        if (newPosition !== 0) {
            client.chatMessage(steamID, 'You have been added to the queue! Please wait your turn, there ' + (newPosition !== 1 ? 'are' : 'is') + ' ' + newPosition + ' infront of you.');
        }

        queue.handleQueue();
    } else if (admin && command === 'get') {
        const params = getParams(message.substring(command.length + 1).trim());

        const match = prices.get(params.sku);

        if (match === null) {
            client.chatMessage(steamID, 'Could not find item "' + params.sku + '" in the pricelist');
        } else {
            client.chatMessage(steamID, '/code ' + JSON.stringify(match, null, 4));
        }
    } else if (admin && command === 'add') {
        const params = getParams(message.substring(command.length + 1).trim());
        delete params.item;

        if (params.enabled === undefined) {
            params.enabled = true;
        }
        if (params.autoprice === undefined) {
            params.autoprice = true;
        }
        if (params.max === undefined) {
            params.max = 1;
        }
        if (params.min === undefined) {
            params.min = 0;
        }
        if (params.intent === undefined) {
            params.intent = 2;
        }

        prices.add(params.sku, params, function (err, entry) {
            if (err) {
                client.chatMessage(steamID, 'Failed to add the item to the pricelist: ' + err.message);
            } else {
                client.chatMessage(steamID, 'Added "' + entry.name + '".');
            }
        });
    } else if (admin && command === 'update') {
        const params = getParams(message.substring(command.length + 1).trim());
        delete params.item;

        prices.update(params.sku, params, function (err, entry) {
            if (err) {
                client.chatMessage(steamID, 'Failed to update the item in the pricelist: ' + err.message);
            } else {
                client.chatMessage(steamID, 'Updated "' + entry.name + '".');
            }
        });
    } else if (admin && command === 'remove') {
        const params = getParams(message.substring(command.length + 1).trim());

        prices.remove(params.sku, function (err, entry) {
            if (err) {
                client.chatMessage(steamID, 'Failed to remove the item from the pricelist: ' + err.message);
            } else {
                client.chatMessage(steamID, 'Removed "' + entry.name + '".');
            }
        });
    } else {
        client.chatMessage(steamID, 'I don\'t know what you mean, please type "!help" for all my commands!');
    }
};

function getItemAndAmount (steamID, message) {
    let name = message;
    let amount = 1;

    if (/^[-]?\d+$/.test(name.split(' ')[0])) {
        // Check if the first part of the name is a number, if so, then that is the amount the user wants to trade
        amount = parseInt(name.split(' ')[0]);
        name = name.replace(amount, '').trim();
    }

    if (1 > amount) {
        amount = 1;
    }

    if (!name) {
        client.chatMessage(steamID, 'You forgot to add a name. Here\'s an example: "!price Team Captain"');
        return null;
    }

    let match = prices.searchByName(name);
    if (match === null) {
        client.chatMessage(steamID, 'I could not find any items in my pricelist that contains "' + name + '", I might not be trading the item you are looking for.');
        return null;
    } else if (Array.isArray(match)) {
        const matchCount = match.length;
        if (match.length > 20) {
            match = match.splice(0, 20);
        }

        let reply = 'I\'ve found ' + match.length + ' items. Try with one of the items shown below:\n' + match.join(',\n');
        if (matchCount > match.length) {
            const other = matchCount - match.length;
            reply += ',\nand ' + other + ' other ' + pluralize('item', other) + '.';
        }

        client.chatMessage(steamID, reply);
        return null;
    }

    return {
        amount: amount,
        match: match
    };
}