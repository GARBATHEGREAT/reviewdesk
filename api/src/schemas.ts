import { z } from 'zod';

export const uuid = z.string().uuid('Must be a valid id');

export const registerBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(128)
    .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), 'Password must contain a letter and a number'),
});

export const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export const roleBody = z.object({ role: z.enum(['admin', 'reviewer', 'viewer']) });

export const projectBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(2000).default(''),
  rubric: z.string().trim().max(5000).default(''),
  requiredReviews: z.number().int().min(1).max(10).default(2),
});

export const projectPatch = projectBody.partial().extend({ archived: z.boolean().optional() });

export const tasksBody = z.object({
  tasks: z
    .array(
      z.object({
        prompt: z.string().trim().min(1, 'Prompt is required').max(10_000),
        response: z.string().trim().min(1, 'Response is required').max(20_000),
      }),
    )
    .min(1)
    .max(100),
});

export const taskPatch = z.object({ assigneeId: uuid.nullable() });

export const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  verdict: z.enum(['pass', 'fail', 'unsure']),
  notes: z.string().trim().max(5000).default(''),
});

export const listQuery = z.object({
  status: z.enum(['open', 'in_review', 'done']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
