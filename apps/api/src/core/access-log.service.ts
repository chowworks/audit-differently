import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { Caller } from './caller'

/** Every read, list, download and export of a document or participant row, and every write to a report. */
@Injectable()
export class AccessLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    caller: Caller,
    entry: {
      workspaceId: string
      resource: 'engagement' | 'document' | 'expense' | 'report' | 'participant' | 'export'
      subjectId?: string | null
      action:
        | 'read'
        | 'list'
        | 'download'
        | 'create'
        | 'update'
        | 'delete'
        | 'export'
        | 'submit'
        | 'review'
      detail?: string
    }
  ): Promise<void> {
    await this.prisma.dataAccessLog.create({
      data: {
        workspaceId: entry.workspaceId,
        actorId: caller.userId,
        actorName: caller.displayName,
        resource: entry.resource,
        subjectId: entry.subjectId ?? null,
        action: entry.action,
        detail: entry.detail,
      },
    })
  }
}
