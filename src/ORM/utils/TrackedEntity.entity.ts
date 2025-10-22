import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

import { DateTimeTransformer } from './DateTimeTransformer';

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true, transformer: new DateTimeTransformer() })
    public deletedAt?: Date;

    @CreateDateColumn({ transformer: new DateTimeTransformer() })
    public createdAt?: Date;

    @UpdateDateColumn({ transformer: new DateTimeTransformer() })
    public updatedAt?: Date;
}
