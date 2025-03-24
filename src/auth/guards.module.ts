// src/guards/guards.module.ts
import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class GuardsModule {}