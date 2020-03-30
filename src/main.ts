'use strict';
import {Bookstore} from "./bookstores/bookstore";

const constants = require('../config/config.json');
const stores = require('../config/bookstores.json.tmp');

async function getBooksFromStore(storeItem: any, cookiesDir: string, booksDir: string, maxFileSize: number) {
    const storeModule = await import("./bookstores/" + storeItem.moduleName);
    const storeInstance: Bookstore = new storeModule[storeItem.controllerName](storeItem, cookiesDir, booksDir, maxFileSize);
    await storeInstance.getBooks();
}

async function getBooksFromStores() {
    for (let storeItem of stores) {
        const {bookstoreName, login} = storeItem;
        var storeConfig = await import("../config/bookstores/" + storeItem.name);
        storeConfig.login = storeItem.login
        storeConfig.password = storeItem.password

        await getBooksFromStore(storeItem, constants.cookiesDir, constants.booksDir, constants.maxFileSize)
            .then(() => console.log(`${new Date().toISOString()} - ${bookstoreName} for ${login}\t\tFinished\n`))
            .catch(error => console.log(`${new Date().toISOString()} - ${bookstoreName} for ${login}\t\tFAILED - ${error}\n`));
    }
}

getBooksFromStores();