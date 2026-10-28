export const STATUS = Object.freeze({
  pending: 'Pending',
  picked_up: 'Picked up',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
});

export const CARRIERS = Object.freeze([
  'Blue Dart', 'Delhivery', 'DTDC', 'Ekart', 'India Post',
  'Ecom Express', 'DHL', 'FedEx', 'UPS', 'USPS', 'Other',
]);

export const SERVICES = Object.freeze(['Standard', 'Express', 'Priority']);
