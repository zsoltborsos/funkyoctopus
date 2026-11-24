import {
  MethodRegistry,
  type CallHandler,
} from '../transport/registry.ts';

type UntypedCallRegistration = {
  call(name: string, handler: CallHandler): MethodRegistry;
};

/** Test-only view for synthetic or deliberately partial method fixtures. */
export function untypedRegistryForTest(
  registry: MethodRegistry = new MethodRegistry(),
): MethodRegistry & UntypedCallRegistration {
  return registry;
}

/** Register one synthetic or deliberately partial call fixture. */
export function registerUntypedForTest(
  registry: MethodRegistry,
  name: string,
  handler: CallHandler,
): MethodRegistry {
  return untypedRegistryForTest(registry).call(name, handler);
}
