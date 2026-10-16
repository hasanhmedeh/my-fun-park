import { Transform, type TransformFnParams } from 'class-transformer';
import { IsObject } from 'class-validator';

/** POST /workshop/designs and PUT /workshop/designs/:id: the whole design (checked by cleanDesign, design.ts). */
export class DesignDto {
  // Taken exactly as parsed: cleanDesign checks every field, and copies what it keeps.
  @Transform(({ obj }: TransformFnParams) => (obj as { design?: unknown }).design)
  @IsObject()
  design!: Record<string, unknown>;
}
