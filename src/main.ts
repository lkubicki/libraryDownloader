'use strict';
import {Bookstore} from "./bookstores/bookstore";

const constants = require('../config/config.json');
const stores = require('../config/bookstores.json');

async function getBooksFromStore(storeItem: any, cookiesDir: string, booksDir: string, maxFileSize: number) {
    const storeModule = await import("./bookstores/" + storeItem.moduleName);
    const storeInstance: Bookstore = new storeModule[storeItem.controllerName](storeItem, cookiesDir, booksDir, maxFileSize);
    await storeInstance.getBooks();
}

async function getBooksFromStores() {
    for (let storeItem of stores) {
        let storeConfig = await import("../config/bookstores/" + storeItem.name);
        storeConfig.login = storeItem.login;
        storeConfig.password = storeItem.password;
        const {bookstoreName, login} = storeConfig;

        await getBooksFromStore(storeConfig, constants.cookiesDir, constants.booksDir, constants.maxFileSize)
            .then(() => console.log(`${new Date().toISOString()} - ${bookstoreName} for ${login}\t\tFinished\n`))
            .catch(error => console.log(`${new Date().toISOString()} - ${bookstoreName} for ${login}\t\tFAILED - ${error}\n`));
    }
}

getBooksFromStores()
    .then(() => console.log(`${new Date().toISOString()} - FINISHED`));