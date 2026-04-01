import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class RpcBlockEntity {

    @PrimaryColumn({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
    blockHeight: number;

    @Column({ nullable: true })
    lockedBy?: string;

    @Column({ nullable: true })
    data?: string;
}