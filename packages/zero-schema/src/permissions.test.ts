import {expect, test} from 'vitest';
import {createSchema} from './schema.js';
import {createTableSchema, type TableSchema} from './table-schema.js';
import {definePermissions} from './permissions.js';
import type {ExpressionBuilder} from '../../zql/src/query/expression.js';

const userSchema = createTableSchema({
  tableName: 'user',
  columns: {
    id: {type: 'string'},
    login: {type: 'string'},
    name: {type: 'string'},
    avatar: {type: 'string'},
    role: {type: 'string'},
  },
  primaryKey: ['id'],
  relationships: {},
});
const schema = createSchema({
  version: 1,
  tables: {
    user: userSchema,
  },
});

type AuthData = {
  sub: string;
  role: 'admin' | 'user';
};

test('permission rules create query ASTs', async () => {
  const config = await definePermissions<AuthData, typeof schema>(
    schema,
    () => {
      const allowIfAdmin = (
        authData: AuthData,
        {cmpLit}: ExpressionBuilder<TableSchema>,
      ) => cmpLit(authData.role, '=', 'admin');

      return {
        user: {
          row: {
            insert: [allowIfAdmin],
            update: {
              preMutation: [allowIfAdmin],
            },
            delete: [allowIfAdmin],
          },
        },
      };
    },
  );

  expect(config).toMatchInlineSnapshot(`
    {
      "user": {
        "cell": undefined,
        "row": {
          "delete": [
            [
              "allow",
              {
                "left": {
                  "anchor": "authData",
                  "field": "role",
                  "type": "static",
                },
                "op": "=",
                "right": {
                  "type": "literal",
                  "value": "admin",
                },
                "type": "simple",
              },
            ],
          ],
          "insert": [
            [
              "allow",
              {
                "left": {
                  "anchor": "authData",
                  "field": "role",
                  "type": "static",
                },
                "op": "=",
                "right": {
                  "type": "literal",
                  "value": "admin",
                },
                "type": "simple",
              },
            ],
          ],
          "select": undefined,
          "update": {
            "postMutation": undefined,
            "preMutation": [
              [
                "allow",
                {
                  "left": {
                    "anchor": "authData",
                    "field": "role",
                    "type": "static",
                  },
                  "op": "=",
                  "right": {
                    "type": "literal",
                    "value": "admin",
                  },
                  "type": "simple",
                },
              ],
            ],
          },
        },
      },
    }
  `);
});

test('nested parameters', async () => {
  type AuthData = {
    sub: string;
    attributes: {role: 'admin' | 'user'};
  };
  const config = await definePermissions<AuthData, typeof schema>(
    schema,
    () => {
      const allowIfAdmin = (
        authData: AuthData,
        {cmpLit}: ExpressionBuilder<TableSchema>,
      ) => cmpLit(authData.attributes.role, '=', 'admin');

      return {
        user: {
          row: {
            insert: [allowIfAdmin],
            update: {
              preMutation: [allowIfAdmin],
            },
            delete: [allowIfAdmin],
            select: [allowIfAdmin],
          },
        },
      };
    },
  );

  expect(config).toMatchInlineSnapshot(`
    {
      "user": {
        "cell": undefined,
        "row": {
          "delete": [
            [
              "allow",
              {
                "left": {
                  "anchor": "authData",
                  "field": [
                    "attributes",
                    "role",
                  ],
                  "type": "static",
                },
                "op": "=",
                "right": {
                  "type": "literal",
                  "value": "admin",
                },
                "type": "simple",
              },
            ],
          ],
          "insert": [
            [
              "allow",
              {
                "left": {
                  "anchor": "authData",
                  "field": [
                    "attributes",
                    "role",
                  ],
                  "type": "static",
                },
                "op": "=",
                "right": {
                  "type": "literal",
                  "value": "admin",
                },
                "type": "simple",
              },
            ],
          ],
          "select": [
            [
              "allow",
              {
                "left": {
                  "anchor": "authData",
                  "field": [
                    "attributes",
                    "role",
                  ],
                  "type": "static",
                },
                "op": "=",
                "right": {
                  "type": "literal",
                  "value": "admin",
                },
                "type": "simple",
              },
            ],
          ],
          "update": {
            "postMutation": undefined,
            "preMutation": [
              [
                "allow",
                {
                  "left": {
                    "anchor": "authData",
                    "field": [
                      "attributes",
                      "role",
                    ],
                    "type": "static",
                  },
                  "op": "=",
                  "right": {
                    "type": "literal",
                    "value": "admin",
                  },
                  "type": "simple",
                },
              ],
            ],
          },
        },
      },
    }
  `);
});
