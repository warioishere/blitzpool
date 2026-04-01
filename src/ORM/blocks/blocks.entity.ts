import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class BlocksEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: (value: string) => parseInt(value, 10) } })
    height: number;

    @Column({ length: 62, type: 'varchar' })
    minerAddress: string;

    @Column()
    worker: string;

    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Column()
    blockData: string;

}