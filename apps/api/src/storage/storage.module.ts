import { Module } from '@nestjs/common'
import { DOCUMENT_STORAGE } from './document-storage.interface'
import { LocalDiskStorage } from './local-disk-storage'
import { R2DocumentStorage } from './r2-storage'

/** DOCUMENT_STORAGE is R2 when R2_DOCUMENTS_BUCKET is set, else local disk (development only). */
@Module({
  providers: [
    LocalDiskStorage,
    R2DocumentStorage,
    {
      provide: DOCUMENT_STORAGE,
      useFactory: (local: LocalDiskStorage, r2: R2DocumentStorage) =>
        process.env.R2_DOCUMENTS_BUCKET ? r2 : local,
      inject: [LocalDiskStorage, R2DocumentStorage],
    },
  ],
  exports: [DOCUMENT_STORAGE, LocalDiskStorage],
})
export class StorageModule {}
