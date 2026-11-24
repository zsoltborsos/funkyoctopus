import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { WORKFLOW } from './workflow.client.ts';
import { ScoutSettings } from './ScoutSettings.tsx';
import { WireCallError } from '@shared/transport/errors.ts';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';
import { scoutSettingsFixture } from './scout-settings.fixture.ts';

function setup(status: ReturnType<typeof makeHelmraiserStatus> | null = null) {
  const settings = scoutSettingsFixture();
  const workflow = { scoutSettings: vi.fn().mockResolvedValue(settings), setScoutSettings: vi.fn().mockResolvedValue(settings), resetScoutSettings: vi.fn().mockResolvedValue(settings) };
  const container = new Container();
  container.registerInstance(WORKFLOW, workflow as never);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const view = (nextStatus: typeof status) => <ContainerProvider container={container}><ScoutSettings status={nextStatus} onRefresh={refresh} disabled={false} /></ContainerProvider>;
  const rendered = render(view(status));
  return { ...workflow, refresh, updateStatus: (nextStatus: typeof status) => rendered.rerender(view(nextStatus)) };
}
describe('ScoutSettings', () => {
  it('shows a settings row for every lens Helmraiser has, guardrails included', async () => {
    const workflow = setup();
    await screen.findByRole('spinbutton', { name: 'state cooldown hours' });
    for (const lens of ['state', 'docs', 'tests', 'guardrails']) {
      expect(screen.getByRole('checkbox', { name: `${lens} automatic` })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('checkbox', { name: 'guardrails automatic' }));
    await waitFor(() => expect(workflow.setScoutSettings).toHaveBeenCalledExactlyOnceWith({ lens: 'guardrails', auto: true }));
  });

  it('skips a lens an older Helmraiser does not report instead of failing', async () => {
    const older = scoutSettingsFixture();
    delete (older.lenses as Partial<typeof older.lenses>).guardrails;
    const status = makeHelmraiserStatus();
    status.scouts = { focus_projects: [], paused_projects: [], pending: [], running: [], recent: [], lenses: older.lenses };
    setup(status);
    expect(await screen.findByRole('checkbox', { name: 'tests automatic' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'guardrails automatic' })).not.toBeInTheDocument();
  });

  it('preserves docs and state cooldown edits when toggling state automatic scouting', async () => {
    const workflow = setup();
    const docs = await screen.findByRole('spinbutton', { name: 'docs cooldown hours' });
    const state = screen.getByRole('spinbutton', { name: 'state cooldown hours' });
    fireEvent.change(docs, { target: { value: '3.5' } });
    fireEvent.change(state, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'state automatic' }));
    await waitFor(() => expect(workflow.refresh).toHaveBeenCalledOnce());
    expect(workflow.setScoutSettings).toHaveBeenCalledExactlyOnceWith({ lens: 'state', auto: true });
    expect(docs).toHaveValue(3.5);
    expect(state).toHaveValue(2.5);
  });

  it.each(['save', 'reset'] as const)('clears only the cooldown for the lens explicitly changed by %s', async (action) => {
    const workflow = setup();
    const docs = await screen.findByRole('spinbutton', { name: 'docs cooldown hours' });
    const tests = screen.getByRole('spinbutton', { name: 'tests cooldown hours' });
    fireEvent.change(docs, { target: { value: '3.5' } });
    fireEvent.change(tests, { target: { value: '2.5' } });
    const result = scoutSettingsFixture();
    result.lenses.tests.cooldown_hours = 4;
    workflow.setScoutSettings.mockResolvedValue(result);
    workflow.resetScoutSettings.mockResolvedValue(result);
    fireEvent.click(within(tests.closest('fieldset')!).getByText(action === 'save' ? 'Save cooldown' : 'Reset to default'));
    await waitFor(() => expect(workflow.refresh).toHaveBeenCalledOnce());
    if (action === 'save') expect(workflow.setScoutSettings).toHaveBeenCalledExactlyOnceWith({ lens: 'tests', cooldownHours: 2.5 });
    else expect(workflow.resetScoutSettings).toHaveBeenCalledExactlyOnceWith('tests');
    expect(docs).toHaveValue(3.5);
    expect(tests).toHaveValue(4);
  });

  it.each([true, false])('preserves dirty cooldowns across background refreshes (status lenses: %s)', async (embedded) => {
    const status = makeHelmraiserStatus();
    status.scouts = { focus_projects: [], paused_projects: [], pending: [], running: [], recent: [],
      ...(embedded ? { lenses: scoutSettingsFixture().lenses } : {}) };
    const workflow = setup(status);
    const input = await screen.findByRole('spinbutton', { name: 'state cooldown hours' });
    fireEvent.change(input, { target: { value: '1.5' } });
    const updated = scoutSettingsFixture();
    updated.lenses.state.auto = true;
    updated.lenses.state.cooldown_hours = 48;
    updated.lenses.docs.cooldown_hours = 36;
    workflow.scoutSettings.mockResolvedValue(updated);
    workflow.updateStatus({ ...status, scouts: { ...status.scouts, ...(embedded ? { lenses: updated.lenses } : {}) } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'state automatic' })).toBeChecked());
    expect(input).toHaveValue(1.5);
    expect(screen.getByRole('spinbutton', { name: 'docs cooldown hours' })).toHaveValue(36);
    expect(workflow.setScoutSettings).not.toHaveBeenCalled();
    fireEvent.click(within(input.closest('fieldset')!).getByText('Save cooldown'));
    await waitFor(() => expect(workflow.setScoutSettings).toHaveBeenCalledExactlyOnceWith({ lens: 'state', cooldownHours: 1.5 }));
    await waitFor(() => expect(input).toBeEnabled());
  });

  it('shows a typed settings validation refusal inline without treating it as success', async () => {
    const workflow = setup();
    const input = await screen.findByRole('spinbutton', { name: 'state cooldown hours' });
    fireEvent.change(input, { target: { value: '1.5' } });
    const refusal = new WireCallError('helmraiser drafts failed: cooldown_hours must be greater than zero', 'helmraiser_cli_error');
    workflow.setScoutSettings.mockRejectedValue(refusal);
    fireEvent.click(within(input.closest('fieldset')!).getByText('Save cooldown'));
    expect(await screen.findByRole('alert')).toHaveTextContent(refusal.message);
    expect(input).toBeEnabled();
    expect(input).toHaveValue(1.5);
    expect(workflow.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'state automatic' })).not.toBeChecked();
  });
  it('prefers status lenses and does not issue a fallback read', async () => {
    const status = makeHelmraiserStatus();
    status.scouts = { focus_projects: [], paused_projects: [], pending: [], running: [], recent: [], lenses: scoutSettingsFixture().lenses };
    const workflow = setup(status);
    await screen.findByRole('checkbox', { name: 'state automatic' });
    expect(workflow.scoutSettings).not.toHaveBeenCalled();
  });
  it('reads and renders all lenses and sources without writing', async () => {
    const workflow = setup();
    await screen.findByRole('checkbox', { name: 'state automatic' });
    const expected = [
      { lens: 'state', checked: false, cooldown: 24, autoSource: 'default', cooldownSource: 'default', reset: false },
      { lens: 'docs', checked: true, cooldown: 12, autoSource: 'ledger', cooldownSource: 'config', reset: true },
      { lens: 'tests', checked: false, cooldown: 6, autoSource: 'config', cooldownSource: 'ledger', reset: true },
      { lens: 'guardrails', checked: false, cooldown: 24, autoSource: 'default', cooldownSource: 'default', reset: false },
    ];
    for (const { lens, checked, cooldown, autoSource, cooldownSource, reset } of expected) {
      const group = within(screen.getByRole('group', { name: lens }));
      const checkbox = group.getByRole('checkbox', { name: `${lens} automatic` });
      if (checked) expect(checkbox).toBeChecked();
      else expect(checkbox).not.toBeChecked();
      expect(group.getByRole('spinbutton', { name: `${lens} cooldown hours` })).toHaveValue(cooldown);
      expect(group.getByText(`auto: ${autoSource}`, { exact: true })).toBeVisible();
      expect(group.getByText(`cooldown: ${cooldownSource}`, { exact: true })).toBeVisible();
      if (reset) expect(group.getByRole('button', { name: 'Reset to default' })).toBeEnabled();
      else expect(group.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(4);
    expect(screen.getAllByText('Reset to default')).toHaveLength(2);
    expect(screen.getByText(/a lens switched on/)).toHaveTextContent('queue pause stops all scouting');
    expect(workflow.setScoutSettings).not.toHaveBeenCalled();
    expect(workflow.resetScoutSettings).not.toHaveBeenCalled();
  });
  it('sends false, fractional cooldown and reset for only the chosen lens', async () => {
    const workflow = setup();
    const toggle = await screen.findByRole('checkbox', { name: 'docs automatic' });
    fireEvent.click(toggle);
    await waitFor(() => expect(workflow.setScoutSettings).toHaveBeenCalledWith({ lens: 'docs', auto: false }));
    await waitFor(() => expect(toggle).toBeEnabled());
    const input = screen.getByRole('spinbutton', { name: 'state cooldown hours' });
    fireEvent.change(input, { target: { value: '0.5' } });
    fireEvent.click(within(input.closest('fieldset')!).getByText('Save cooldown'));
    await waitFor(() => expect(workflow.setScoutSettings).toHaveBeenCalledWith({ lens: 'state', cooldownHours: 0.5 }));
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(within(toggle.closest('fieldset')!).getByText('Reset to default'));
    await waitFor(() => expect(workflow.resetScoutSettings).toHaveBeenCalledWith('docs'));
  });
  it('rejects blank cooldown locally and shows write refusals inline', async () => {
    const workflow = setup();
    const input = await screen.findByRole('spinbutton', { name: 'state cooldown hours' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(within(input.closest('fieldset')!).getByText('Save cooldown'));
    expect(await screen.findByRole('alert')).toHaveTextContent('greater than zero');
    expect(workflow.setScoutSettings).not.toHaveBeenCalled();
    workflow.setScoutSettings.mockRejectedValue(new Error('validation refused'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'state automatic' }));
    expect(await screen.findByText('validation refused')).toBeInTheDocument();
  });
});
