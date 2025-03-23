import { Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from 'src/config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [configuration],
    }),
  ],
  providers: [ConfigService, SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
