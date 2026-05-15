import { BeforeInsert, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { epochMsTransformer } from '../utils/epoch-ms-transformer';

export type PplnsGroupMemberRole = 'creator' | 'member';

@Entity('pplns_group_member')
export class PplnsGroupMemberEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ type: 'uuid' })
    groupId: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 62 })
    address: string;

    @Column({ type: 'varchar', length: 16, default: 'member' })
    role: PplnsGroupMemberRole;

    @Column({ type: 'bigint', transformer: epochMsTransformer })
    joinedAt: number;

    @BeforeInsert()
    private fillJoinedAt(): void {
        if (this.joinedAt == null) this.joinedAt = Date.now();
    }
}
