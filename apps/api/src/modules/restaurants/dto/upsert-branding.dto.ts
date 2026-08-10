import { z } from 'zod';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const UpsertBrandingDto = z.object({
  logoUrl: z.string().trim().url().max(2000).nullish(),
  coverImageUrl: z.string().trim().url().max(2000).nullish(),
  themePrimaryColor: z
    .string()
    .trim()
    .regex(HEX_COLOR, 'Must be a hex color like #RRGGBB')
    .nullish(),
  themeAccentColor: z
    .string()
    .trim()
    .regex(HEX_COLOR, 'Must be a hex color like #RRGGBB')
    .nullish(),
  tagline: z.string().trim().max(200).nullish(),
});

export type UpsertBrandingInput = z.infer<typeof UpsertBrandingDto>;
