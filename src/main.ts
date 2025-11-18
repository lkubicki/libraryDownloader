import {Bookstore} from "./bookstores/bookstore";

import * as constants from '../config/config.json';
import * as bookstores from '../config/bookstores.json';
import FS from "fs";

async function getBooksFromStore(storeItemConfig: any, cookiesDir: string, booksDir: string, maxFileSize: number) {
    try {
        const storeModule = await import("./bookstores/" + storeItemConfig.moduleName);
        const storeInstance: Bookstore = new storeModule[storeItemConfig.controllerName](storeItemConfig, cookiesDir, booksDir, maxFileSize);
        await storeInstance.getBooks();
    } catch (e) {
        console.log(`${new Date().toISOString()} - ${e}`);
    }
}

async function getBooksFromStores(bookstores: any[], bookstore: string) {
    for (let storeItem of bookstores) {
        if (bookstore == undefined || storeItem.name === bookstore) {
            let storeConfig = await import("../../config/bookstores/" + storeItem.name + ".json");
            storeConfig.login = storeItem.login;
            storeConfig.password = storeItem.password;

            await getBooksFromStore(storeConfig, constants.cookiesDir, constants.booksDir, constants.maxFileSize)
                .then(() => console.log(`${new Date().toISOString()} - ${storeConfig.bookstoreName} for ${storeConfig.login}\t\tFinished\n`))
                .catch(error => console.log(`${new Date().toISOString()} - ${storeConfig.bookstoreName} for ${storeConfig.login}\t\tFAILED - ${error}\n`));
        }
    }
}

if (!FS.existsSync(constants.cookiesDir)) {
    FS.mkdirSync(constants.cookiesDir);
}
getBooksFromStores(bookstores.stores, process.argv[2])
    .then(() => console.log(`${new Date().toISOString()} - FINISHED`));

