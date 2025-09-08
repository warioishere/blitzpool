export interface IPeerInfo {
    addr: string,
    addrlocal?: string,
    subver: string,
    inbound: boolean,
    bytesrecv: number,
    bytessent: number
}
