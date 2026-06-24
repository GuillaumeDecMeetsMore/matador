import { describe, expect, it } from 'bun:test';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { MatadorModule } from '../src/module/matador.module.js';
import { MatadorService } from '../src/services/matador.service.js';
import { MatadorTestingModule } from '../src/testing/matador-testing.module.js';

describe('MatadorModule dependency injection', () => {
  it('resolves MatadorService via real Nest DI (forRoot)', async () => {
    // This boots a real Nest injector, which relies on emitted
    // `design:paramtypes` metadata to inject MatadorService's constructor
    // dependencies. If a constructor dependency is imported with `import type`,
    // its runtime class value is erased and Nest sees `Object`, failing with
    // "Nest can't resolve dependencies of the MatadorService".
    const moduleRef = await Test.createTestingModule({
      imports: [MatadorTestingModule.forTest({ autoStart: false })],
    }).compile();

    const service = moduleRef.get(MatadorService);
    expect(service).toBeInstanceOf(MatadorService);

    await moduleRef.close();
  });

  it('exposes the injected discovery dependency as a runtime value', () => {
    // Guards against the recurring lint regression that rewrites the
    // SubscriberDiscoveryService import to `import type`, which erases the
    // runtime metadata Nest needs. The second constructor parameter must carry
    // a real class as its design:paramtype, not `Object`.
    const paramTypes: unknown[] =
      Reflect.getMetadata('design:paramtypes', MatadorService) ?? [];

    expect(paramTypes.length).toBe(2);
    expect(paramTypes[1]).not.toBe(Object);
  });
});
