"use strict";

export class timingUtils {
    public static readonly ONE_SECOND: number = 1000;

    public static async delay(delay: number) {
        return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * delay / 2) + delay / 2));
    }

    public static async delayExactly(delay: number) {
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}