import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex, TableUnique } from 'typeorm';

/**
 * Creates the three Blockparty tables:
 *   - blockparty_group         (party state machine + admin auth)
 *   - blockparty_member        (per-member percentBp split + confirmation)
 *   - blockparty_block_history (per-block payout snapshot, no balance ledger)
 *
 * No pending/balance table because Blockparty pays out entirely in the
 * coinbase — sub-dust amounts roll into the pool-fee output per
 * project decision, not into a carry-forward balance.
 */
export class AddBlockpartyTables1782000000000 implements MigrationInterface {
    name = 'AddBlockpartyTables1782000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const BIGINT_NOW_MS = `(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;

        // ── blockparty_group ────────────────────────────────────────────
        await queryRunner.createTable(new Table({
            name: 'blockparty_group',
            columns: [
                { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
                { name: 'name', type: 'varchar', length: '64', isNullable: false },
                { name: 'adminAddress', type: 'varchar', length: '62', isNullable: false },
                { name: 'adminTokenHash', type: 'varchar', length: '64', isNullable: false },
                { name: 'status', type: 'varchar', length: '16', default: `'draft'`, isNullable: false },
                { name: 'lastShareAt', type: 'bigint', isNullable: true },
                // Optional admin-set display hint (e.g. "MRR" / "Braiins" /
                // "Nicehash") — surfaces on the public detail page so members
                // know where the rental hashpower comes from. No backend
                // semantics; pure UI metadata.
                { name: 'rentalProviderHint', type: 'varchar', length: '64', isNullable: true },
                { name: 'createdAt', type: 'bigint', default: BIGINT_NOW_MS, isNullable: false },
                { name: 'updatedAt', type: 'bigint', default: BIGINT_NOW_MS, isNullable: false },
                { name: 'dissolvedAt', type: 'bigint', isNullable: true },
            ],
        }), true);

        await queryRunner.createIndex('blockparty_group', new TableIndex({
            name: 'UQ_blockparty_group_name',
            columnNames: ['name'],
            isUnique: true,
        }));

        await queryRunner.createIndex('blockparty_group', new TableIndex({
            name: 'UQ_blockparty_group_admin_address',
            columnNames: ['adminAddress'],
            isUnique: true,
        }));

        await queryRunner.createIndex('blockparty_group', new TableIndex({
            name: 'IDX_blockparty_group_status',
            columnNames: ['status'],
        }));

        // ── blockparty_member ───────────────────────────────────────────
        await queryRunner.createTable(new Table({
            name: 'blockparty_member',
            columns: [
                { name: 'id', type: 'bigserial', isPrimary: true },
                { name: 'groupId', type: 'uuid', isNullable: false },
                { name: 'address', type: 'varchar', length: '62', isNullable: false },
                { name: 'email', type: 'varchar', length: '320', isNullable: false },
                { name: 'percentBp', type: 'int', isNullable: false },
                { name: 'role', type: 'varchar', length: '16', default: `'member'`, isNullable: false },
                { name: 'confirmedAt', type: 'bigint', isNullable: true },
                // SHA-256 of the member's persistent token, minted on first
                // accept of an invitation. Used for re-confirmations after
                // admin %-edits and for gated read access to the admin/detail
                // page. Null until first accept (members never approved
                // before the column existed would also stay null).
                { name: 'memberTokenHash', type: 'varchar', length: '64', isNullable: true },
                { name: 'createdAt', type: 'bigint', default: BIGINT_NOW_MS, isNullable: false },
                { name: 'updatedAt', type: 'bigint', default: BIGINT_NOW_MS, isNullable: false },
            ],
            uniques: [
                new TableUnique({
                    name: 'UQ_blockparty_member_group_address',
                    columnNames: ['groupId', 'address'],
                }),
            ],
            foreignKeys: [
                new TableForeignKey({
                    name: 'FK_blockparty_member_group',
                    columnNames: ['groupId'],
                    referencedTableName: 'blockparty_group',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            ],
        }), true);

        // Globally unique address — an address can only be in one Blockparty.
        await queryRunner.createIndex('blockparty_member', new TableIndex({
            name: 'UQ_blockparty_member_address',
            columnNames: ['address'],
            isUnique: true,
        }));

        await queryRunner.createIndex('blockparty_member', new TableIndex({
            name: 'IDX_blockparty_member_group',
            columnNames: ['groupId'],
        }));

        // ── blockparty_block_history ────────────────────────────────────
        await queryRunner.createTable(new Table({
            name: 'blockparty_block_history',
            columns: [
                { name: 'id', type: 'bigserial', isPrimary: true },
                { name: 'groupId', type: 'uuid', isNullable: false },
                { name: 'blockHeight', type: 'int', isNullable: false },
                { name: 'blockHash', type: 'varchar', length: '64', isNullable: false },
                { name: 'foundAt', type: 'bigint', isNullable: false },
                { name: 'coinbaseValueSats', type: 'bigint', isNullable: false },
                { name: 'poolFeeSats', type: 'bigint', isNullable: false },
                { name: 'splits', type: 'jsonb', isNullable: false },
                { name: 'createdAt', type: 'bigint', default: BIGINT_NOW_MS, isNullable: false },
            ],
            foreignKeys: [
                new TableForeignKey({
                    name: 'FK_blockparty_block_history_group',
                    columnNames: ['groupId'],
                    referencedTableName: 'blockparty_group',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            ],
        }), true);

        await queryRunner.createIndex('blockparty_block_history', new TableIndex({
            name: 'UQ_blockparty_block_history_group_hash',
            columnNames: ['groupId', 'blockHash'],
            isUnique: true,
        }));

        await queryRunner.createIndex('blockparty_block_history', new TableIndex({
            name: 'IDX_blockparty_block_history_group',
            columnNames: ['groupId'],
        }));

        await queryRunner.createIndex('blockparty_block_history', new TableIndex({
            name: 'IDX_blockparty_block_history_height',
            columnNames: ['blockHeight'],
        }));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('blockparty_block_history', true);
        await queryRunner.dropTable('blockparty_member', true);
        await queryRunner.dropTable('blockparty_group', true);
    }
}
