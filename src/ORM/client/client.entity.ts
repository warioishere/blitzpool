import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
// No separate @Index needed — PRIMARY KEY (address, clientName, sessionId)
// automatically creates a unique B-tree index in PostgreSQL.
export class ClientEntity extends TrackedEntity {


    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @PrimaryColumn({ length: 64, type: 'varchar' })
    clientName: string;

    @PrimaryColumn({ length: 8, type: 'varchar' })
    sessionId: string;


    @Column({ length: 128, type: 'varchar', nullable: true })
    userAgent: string;



    @Column({ type: 'bigint', transformer: epochMsTransformer })
    startTime: number;

    @Column({ type: 'bigint', nullable: true, transformer: epochMsTransformer })
    firstSeen: number;

    @Column({ type: 'real', default: 0 })
    bestDifficulty: number

    @Column({ type: 'double precision', default: 0 })
    hashRate: number;

    @Column({ type: 'real', nullable: true })
    currentDifficulty: number | null;

}

