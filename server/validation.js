import { STATUS, SERVICES } from './constants.js';

export class InputError extends Error {
  constructor(message, details = undefined, status = 400) {
    super(message);
    this.name = 'InputError';
    this.status = status;
    this.details = details;
  }
}

const LIMITS = {
  trackingNumber: 70,
  carrier: 60,
  recipientName: 100,
  recipientEmail: 160,
  originCity: 100,
  destinationCity: 100,
  service: 30,
  packageDescription: 200,
  reference: 80,
  notes: 1200,
  estimatedDelivery: 10,
  shippedAt: 10,
};
const REQUIRED = ['trackingNumber', 'carrier', 'recipientName', 'originCity', 'destinationCity'];
const OPTIONAL_FIELDS = Object.keys(LIMITS);

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function validateShipment(input, { partial = false } = {}) {
  if (!plainObject(input)) throw new InputError('A shipment object is required.');
  const unknown = Object.keys(input).filter((key) => ![...OPTIONAL_FIELDS, 'weightKg', 'notificationOptIn'].includes(key));
  if (unknown.length) throw new InputError(`Unknown fields: ${unknown.join(', ')}`);

  const errors = {};
  const output = {};
  for (const key of OPTIONAL_FIELDS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string') {
      errors[key] = 'Must be a text value.';
      continue;
    }
    const value = input[key].trim();
    if (value.length > LIMITS[key]) {
      errors[key] = `Must be ${LIMITS[key]} characters or fewer.`;
      continue;
    }
    if (REQUIRED.includes(key) && !value) errors[key] = 'This field is required.';
    if (key === 'trackingNumber' && value && !/^[A-Za-z0-9][A-Za-z0-9._\-/ ]{2,69}$/.test(value)) {
      errors[key] = 'Use 3–70 letters, numbers, spaces, dots, dashes, underscores or slashes.';
    }
    if (key === 'recipientEmail' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors[key] = 'Enter a valid email address.';
    }
    if ((key === 'shippedAt' || key === 'estimatedDelivery') && value && !validDate(value)) {
      errors[key] = 'Enter a valid date (YYYY-MM-DD).';
    }
    if (key === 'service' && value && !SERVICES.includes(value)) {
      errors[key] = 'Select a supported service.';
    }
    output[key] = value;
  }
  if (!partial) {
    for (const key of REQUIRED) if (!output[key]) errors[key] = 'This field is required.';
  }
  if ('notificationOptIn' in input) {
    if (typeof input.notificationOptIn !== 'boolean') errors.notificationOptIn = 'Must be true or false.';
    else output.notificationOptIn = input.notificationOptIn;
  }
  if ('weightKg' in input) {
    const weight = input.weightKg;
    if (weight === null || weight === '') output.weightKg = null;
    else if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100000) {
      errors.weightKg = 'Enter a weight greater than 0 and at most 100,000 kg.';
    } else {
      output.weightKg = Math.round(weight * 1000) / 1000;
    }
  }
  if (output.shippedAt && output.estimatedDelivery && output.shippedAt > output.estimatedDelivery) {
    errors.estimatedDelivery = 'Estimated delivery must be on or after shipping date.';
  }
  if (Object.keys(errors).length) throw new InputError('Please correct the highlighted fields.', errors);
  if (partial && !Object.keys(output).length) throw new InputError('Provide at least one field to update.');
  return output;
}

export function validateEvent(input) {
  if (!plainObject(input)) throw new InputError('An event object is required.');
  const unknown = Object.keys(input).filter((key) => !['status', 'location', 'description'].includes(key));
  if (unknown.length) throw new InputError(`Unknown fields: ${unknown.join(', ')}`);
  const errors = {};
  if (typeof input.status !== 'string' || !(input.status in STATUS)) {
    errors.status = 'Select a valid shipment status.';
  }
  for (const [key, max] of [['location', 100], ['description', 500]]) {
    if (input[key] !== undefined && typeof input[key] !== 'string') errors[key] = 'Must be text.';
    else if (typeof input[key] === 'string' && input[key].trim().length > max) {
      errors[key] = `Must be ${max} characters or fewer.`;
    }
  }
  if (Object.keys(errors).length) throw new InputError('Please correct the event fields.', errors);
  return {
    status: input.status,
    location: input.location?.trim() ?? '',
    description: input.description?.trim() || `Shipment marked ${STATUS[input.status].toLowerCase()}.`,
  };
}
