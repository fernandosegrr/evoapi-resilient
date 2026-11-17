import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

import { EventController } from '../event.controller';

// SQS has a stricter controller contract than the generic event integrations.
export const sqsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    sqs: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        events: {
          type: 'array',
          items: { type: 'string', enum: EventController.events },
        },
      },
      required: ['enabled', 'events'],
    },
  },
  required: ['sqs'],
};
