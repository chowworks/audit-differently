import { Module } from '@nestjs/common'
import { ParticipantsController } from './participants.controller'

@Module({ controllers: [ParticipantsController] })
export class ParticipantsModule {}
