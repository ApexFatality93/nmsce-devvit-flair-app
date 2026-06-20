export type FlairValidationResult = {
    valid: boolean;
    normalizedText: string;
    reasons: string[];
};
export declare function validateEditableFlair(flairText: string | undefined, sourceText: string | undefined): FlairValidationResult;
export declare function validateEventFlair(flairText: string | undefined, sourceText?: string | undefined): FlairValidationResult;
//# sourceMappingURL=flair-validator.d.ts.map