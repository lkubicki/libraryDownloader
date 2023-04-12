"use strict";

import * as FS from "fs";

export class filesystemUtils {
    public static async checkIfDirectoryExists(downloadDirectory: string): Promise<boolean> {
        return FS.existsSync(downloadDirectory);
    }

    public static async checkIfElementExists(downloadDirectory: string, fileName: string): Promise<boolean> {
        const path = `${downloadDirectory}/${fileName}`;
        return FS.existsSync(path) && FS.statSync(path).size > 0;
    }
}