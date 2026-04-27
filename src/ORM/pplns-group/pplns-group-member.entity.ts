import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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

    @CreateDateColumn()
    joinedAt: Date;
}
