export type InitResponse = {
    type: "init";
    postId: string;
    count: number;
    username: string;
};
export type IncrementResponse = {
    type: "increment";
    postId: string;
    count: number;
};
export type IncrementRequest = {
    amount: number;
};
export type DecrementResponse = {
    type: "decrement";
    postId: string;
    count: number;
};
export type DecrementRequest = {
    amount: number;
};
export declare const ApiEndpoint: {
    readonly Init: "/api/init";
    readonly Increment: "/api/increment";
    readonly Decrement: "/api/decrement";
    readonly OnPostCreate: "/internal/menu/post-create";
    readonly OnAppInstall: "/internal/on-app-install";
};
export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];
//# sourceMappingURL=api.d.ts.map