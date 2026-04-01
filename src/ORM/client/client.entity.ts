import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { DateTimeTransformer } from '../utils/DateTimeTransformer';
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



    @Column({ transformer: new DateTimeTransformer() })
    startTime: Date;

    @Column({ transformer: new DateTimeTransformer(), nullable: true })
    firstSeen: Date;

    @Column({ type: 'real', default: 0 })
    bestDifficulty: number

    @Column({ type: 'double precision', default: 0 })
    hashRate: number;

    @Column({ type: 'real', nullable: true })
    currentDifficulty: number | null;

}

