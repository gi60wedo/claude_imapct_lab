import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

afterEach(cleanup);

test('renders the UrbanTwin placeholder', () => {
  render(<div>UrbanTwin</div>);
  expect(screen.getByText('UrbanTwin').textContent).toBe('UrbanTwin');
});
