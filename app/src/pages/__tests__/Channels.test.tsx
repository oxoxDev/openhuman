import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../test/test-utils';
import Channels from '../Channels';

describe('Channels page', () => {
  it('renders the channel selector after loading', async () => {
    renderWithProviders(<Channels />);

    // After loading (fallback definitions), the selector should appear.
    // "Telegram" appears in both the selector tab and config header.
    expect((await screen.findAllByText('Telegram')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Discord').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Web').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the Telegram config panel by default', async () => {
    renderWithProviders(<Channels />);

    // TelegramConfig should render its auth modes.
    expect(await screen.findByText('Managed DM')).toBeInTheDocument();
  });
});
