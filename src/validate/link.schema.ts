import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

// Admin: create a self-service link. Unknown properties are rejected so a typo (e.g. "allowreset") cannot silently
// create a link without the permission the administrator meant to give.
export const linkTokenCreateSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    instanceName: { type: 'string', minLength: 1, maxLength: 255 },
    ttlHours: { type: 'number', exclusiveMinimum: 0, maximum: 168 },
    displayName: { type: 'string', maxLength: 100 },
    allowReset: { type: 'boolean' },
    expectedNumber: { type: 'string', maxLength: 32 },
  },
  required: ['instanceName'],
  additionalProperties: false,
};
